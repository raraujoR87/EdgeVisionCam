"""
Acesso minimo a API do Docker, usado para ler logs de container e reiniciar o
Frigate quando a configuracao de cameras muda.

Por que existe um proxy no meio
-------------------------------
Montar /var/run/docker.sock dentro do container da API da a ela controle total
do host: quem fala com esse socket pode criar um container privilegiado com o
sistema de arquivos do host montado. Ou seja, uma falha de execucao remota na
API deixaria de ser "a API caiu" e passaria a ser "o appliance inteiro e de
outra pessoa" — com camera e gravacoes dentro.

O `docker-socket-proxy` do compose fica entre os dois e so encaminha o que foi
explicitamente liberado (ler containers e reiniciar), recusando o resto. Este
modulo fala com ele por TCP.

O modo socket direto continua disponivel para instalacoes que ainda nao migraram,
e e escolhido automaticamente pela ausencia de DOCKER_PROXY_HOST.
"""

import os
import socket

# Versao da API do Docker usada nas rotas. Mantida fixa de proposito: a API do
# Docker e versionada na URL, e "sem versao" segue a do daemon, que muda sob
# nossos pes numa atualizacao do host.
API_VERSION = "v1.41"

PROXY_HOST = os.getenv("DOCKER_PROXY_HOST", "")
PROXY_PORT = int(os.getenv("DOCKER_PROXY_PORT", "2375"))
SOCKET_PATH = os.getenv("DOCKER_SOCKET_PATH", "/var/run/docker.sock")

TIMEOUT_SEGUNDOS = 10


class DockerIndisponivel(RuntimeError):
    """Nem o proxy nem o socket estao acessiveis."""


def modo() -> str:
    """Devolve 'proxy' ou 'socket', conforme a configuracao vigente."""
    return "proxy" if PROXY_HOST else "socket"


def _conectar() -> socket.socket:
    if PROXY_HOST:
        cliente = socket.create_connection((PROXY_HOST, PROXY_PORT), TIMEOUT_SEGUNDOS)
        return cliente

    if not os.path.exists(SOCKET_PATH):
        raise DockerIndisponivel(
            f"Socket do Docker não encontrado em {SOCKET_PATH} e "
            f"DOCKER_PROXY_HOST não definido."
        )

    cliente = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cliente.settimeout(TIMEOUT_SEGUNDOS)
    cliente.connect(SOCKET_PATH)
    return cliente


def requisitar(metodo: str, caminho: str) -> bytes:
    """
    Executa uma requisicao HTTP/1.1 crua contra a API do Docker e devolve o
    corpo da resposta.

    O protocolo e falado na mao porque a alternativa seria arrastar a biblioteca
    `docker` (e suas dependencias) para dentro da imagem do appliance por causa
    de duas chamadas.
    """
    cliente = _conectar()
    try:
        requisicao = (
            f"{metodo} /{API_VERSION}{caminho} HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Connection: close\r\n\r\n"
        )
        cliente.sendall(requisicao.encode("utf-8"))

        resposta = b""
        while True:
            pedaco = cliente.recv(4096)
            if not pedaco:
                break
            resposta += pedaco
    finally:
        cliente.close()

    partes = resposta.split(b"\r\n\r\n", 1)
    if len(partes) < 2:
        raise DockerIndisponivel("Resposta inválida do daemon Docker.")
    return partes[1]


def reiniciar_container(nome: str) -> bool:
    """Reinicia um container pelo nome. False se o Docker não estiver acessível."""
    try:
        requisitar("POST", f"/containers/{nome}/restart")
        print(f"  [DOCKER] Reinício solicitado para {nome} (via {modo()}).")
        return True
    except DockerIndisponivel as erro:
        print(f"  [DOCKER] {erro}")
        return False
    except Exception as erro:
        print(f"  [DOCKER ERROR] Falha ao reiniciar {nome}: {erro}")
        return False


def ler_logs(nome: str, linhas: int = 150) -> str:
    """Últimas linhas de log de um container, já sem o enquadramento binário."""
    corpo = requisitar(
        "GET", f"/containers/{nome}/logs?stdout=true&stderr=true&tail={linhas}"
    )
    return _desenquadrar(corpo)


def _desenquadrar(corpo: bytes) -> str:
    """
    Remove o cabecalho de 8 bytes que o Docker antepoe a cada trecho de log em
    containers sem TTY. Sem isso, bytes de controle aparecem no console da UI.
    """
    saida = []
    i = 0
    while i < len(corpo):
        cabecalho_valido = (
            i + 8 <= len(corpo)
            and corpo[i] in (0, 1, 2)
            and corpo[i + 1] == 0
            and corpo[i + 2] == 0
            and corpo[i + 3] == 0
        )
        if cabecalho_valido:
            tamanho = int.from_bytes(corpo[i + 4:i + 8], byteorder="big")
            saida.append(corpo[i + 8:i + 8 + tamanho].decode("utf-8", errors="ignore"))
            i += 8 + tamanho
        else:
            # Container com TTY: o fluxo vem cru, sem enquadramento.
            saida.append(corpo[i:].decode("utf-8", errors="ignore"))
            break
    return "".join(saida)
