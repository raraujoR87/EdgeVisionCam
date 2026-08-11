"""
Execução de comandos remotos vindos do console.

O appliance mora atrás do NAT da loja: não há como a nuvem abrir conexão até
ele, e abrir uma (túnel reverso, VPN, porta encaminhada no roteador do cliente)
significaria manter uma porta de entrada em cada loja da frota. Então quem
puxa é o appliance — no mesmo ritmo em que já manda telemetria.

---------------------------------------------------------------------------
POR QUE A LISTA DE COMANDOS É CONFERIDA AQUI TAMBÉM
---------------------------------------------------------------------------

A nuvem já valida o comando antes de enfileirar (ui/app/api/comandos.ts). Esta
segunda conferência não é redundância por descuido: é a suposição de que a
nuvem pode estar errada.

O appliance tem câmera, gravação e acesso à rede da loja. Se a única barreira
morasse do lado do servidor, comprometer o servidor — ou a conta de um
administrador — passaria a valer execução de código em toda loja do cliente.
Com a lista aqui, o pior caso continua sendo reiniciar container e ler log.

Pelo mesmo motivo a nuvem manda apelido de serviço (`engine`, `frigate`,
`mqtt`) e não nome de container: a tradução acontece aqui, contra um dicionário
fechado. A nuvem não tem como pedir o restart de um container arbitrário do
host, porque não tem como nomeá-lo.

A terceira camada é o `docker-socket-proxy` do compose, que só encaminha leitura
de containers e restart — `/exec` e `/containers/create` ficam negados mesmo que
este arquivo peça. Ver o comentário no docker-compose.yml.
"""

import json
import os
import sys
import urllib.error
import urllib.request

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core import docker_client
from shared.metrics import get_avg_inference_ms

TIMEOUT_SEGUNDOS = 15

# Quantos comandos processar por rodada. A nuvem já limita a entrega, mas o
# teto local impede que uma fila represada monopolize o loop do agente.
MAX_POR_RODADA = 5

# Apelido de serviço -> container. É este dicionário que a nuvem não consegue
# contornar: um valor fora daqui não vira nome de container, vira recusa.
SERVICOS = {
    "engine": "visioncam-core",
    "frigate": "visioncam-frigate",
    "mqtt": "visioncam-mqtt",
}

MAX_LINHAS_LOG = 500
LINHAS_LOG_PADRAO = 150


class ComandoRecusado(RuntimeError):
    """O comando não está no conjunto que este appliance executa."""


def _servico(parametros: dict, padrao: str = "engine") -> str:
    apelido = str((parametros or {}).get("servico", padrao))
    if apelido not in SERVICOS:
        raise ComandoRecusado(f"Serviço fora da lista: {apelido}")
    return SERVICOS[apelido]


def _reiniciar(apelido: str):
    # Resolvido na definição, não a cada chamada: um apelido errado aqui vira
    # KeyError no import, e não uma falha na loja no dia em que alguém clicar.
    container = SERVICOS[apelido]

    def executor(parametros: dict) -> dict:
        if not docker_client.reiniciar_container(container):
            # reiniciar_container já imprime a causa; o que sobe para a nuvem é
            # o veredito, porque é ele que o operador lê na tela.
            raise RuntimeError(f"Docker não aceitou reiniciar {container}.")
        return {"container": container, "acao": "restart"}

    return executor


def _coletar_logs(parametros: dict) -> dict:
    container = _servico(parametros)

    linhas = (parametros or {}).get("linhas", LINHAS_LOG_PADRAO)

    # Inteiro de verdade, não o que `int()` conseguir extrair. `int(1.5)` daria
    # 1 e `int("20")` daria 20 — os dois aceitariam um valor que a nuvem
    # recusaria (`Number.isInteger`), e o par de validações só protege enquanto
    # as duas concordam sobre o que é válido. `bool` é subclasse de `int` em
    # Python, daí a exclusão explícita.
    if isinstance(linhas, bool) or not isinstance(linhas, int):
        raise ComandoRecusado(f"linhas deve ser inteiro, veio {linhas!r}")
    if not 1 <= linhas <= MAX_LINHAS_LOG:
        raise ComandoRecusado(f"linhas fora do intervalo 1..{MAX_LINHAS_LOG}: {linhas}")

    return {"container": container, "linhas": linhas, "logs": docker_client.ler_logs(container, linhas)}


def _diagnostico(parametros: dict) -> dict:
    """
    Fotografia do appliance, respondendo à pergunta que motiva a maioria dos
    chamados: "a loja está protegida agora?".

    `inference_ms` é o campo que distingue container de pé de engine
    detectando. Um appliance com CPU baixa e inferência zerada está no ar e
    cego — que é o estado que ninguém percebe pelo painel.
    """
    from edge.local_agent import get_system_stats
    from edge_hardware import NPU_DEVICE

    cpu, ram = get_system_stats()
    pose_model = os.getenv("POSE_MODEL_PATH", "")
    npu = "ACTIVE_VIPLITE"
    if pose_model.endswith(".pt") or not os.path.exists(NPU_DEVICE):
        npu = "CPU_FALLBACK"

    return {
        "cpu_usage": cpu,
        "ram_usage": ram,
        "npu_status": npu,
        "inference_ms": get_avg_inference_ms(),
        "versao": os.getenv("VISIONCAM_TAG", "desconhecida"),
        "docker": docker_client.modo(),
    }


# A lista fechada. Acrescentar uma entrada aqui é acrescentar poder que a nuvem
# passa a ter sobre a loja — a revisão dessa linha é a revisão que importa.
COMANDOS = {
    "reiniciar_engine": _reiniciar("engine"),
    "reiniciar_frigate": _reiniciar("frigate"),
    "reiniciar_mqtt": _reiniciar("mqtt"),
    "coletar_logs": _coletar_logs,
    "diagnostico": _diagnostico,
}


def executar(comando: str, parametros: dict = None) -> tuple:
    """
    Executa um comando e devolve `(status, resultado)`.

    Não levanta exceção: uma falha de execução é um resultado que a nuvem
    precisa receber, não um erro que derruba o loop de poll. Um appliance que
    para de reportar por causa de um comando ruim é um appliance que some do
    painel — e "sumiu" é a informação menos útil possível.
    """
    executor = COMANDOS.get(comando)
    if executor is None:
        return "FALHOU", {"erro": f"Comando não reconhecido pelo appliance: {comando}"}

    try:
        return "CONCLUIDO", executor(parametros or {})
    except ComandoRecusado as erro:
        return "FALHOU", {"erro": str(erro)}
    except docker_client.DockerIndisponivel as erro:
        return "FALHOU", {"erro": f"Docker inacessível a partir do container: {erro}"}
    except Exception as erro:  # noqa: BLE001 — ver docstring
        return "FALHOU", {"erro": f"{type(erro).__name__}: {erro}"}


# ── Conversa com a nuvem ────────────────────────────────────────────────────


def _requisitar(url: str, api_key: str, corpo: dict = None) -> dict:
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    requisicao = urllib.request.Request(
        url,
        data=dados,
        headers={"x-store-api-key": api_key, "Content-Type": "application/json"},
        method="POST" if dados is not None else "GET",
    )
    with urllib.request.urlopen(requisicao, timeout=TIMEOUT_SEGUNDOS) as resposta:
        return json.loads(resposta.read().decode("utf-8"))


def buscar(cloud_url: str, api_key: str) -> list:
    """Comandos que a nuvem entregou a este appliance nesta rodada."""
    url = f"{cloud_url.rstrip('/')}/api/edge/commands"
    return _requisitar(url, api_key).get("comandos", [])[:MAX_POR_RODADA]


def reportar(cloud_url: str, api_key: str, comando_id, status: str, resultado: dict) -> None:
    """Devolve o desfecho de um comando."""
    url = f"{cloud_url.rstrip('/')}/api/edge/commands"
    _requisitar(url, api_key, {"id": comando_id, "status": status, "resultado": resultado})


def processar_rodada(cloud_url: str, api_key: str, log=print) -> int:
    """
    Uma rodada de poll: busca, executa e reporta. Devolve quantos executou.

    Cada comando é reportado logo após executar, e não em lote no fim: se a
    rede cair no meio, o console fica sabendo dos que já rodaram em vez de
    exibir a rodada inteira como pendente.
    """
    if not cloud_url or not api_key:
        return 0

    try:
        comandos = buscar(cloud_url, api_key)
    except urllib.error.HTTPError as erro:
        # 401 é configuração (edge_key errada ou appliance revogado), não uma
        # falha passageira. Dizer isso evita horas procurando problema de rede.
        if erro.code == 401:
            log("  [COMANDOS] Nuvem recusou a edge_key deste appliance.")
        else:
            log(f"  [COMANDOS] Nuvem respondeu HTTP {erro.code} ao buscar a fila.")
        return 0
    except Exception as erro:  # rede da loja cai o tempo todo; tenta de novo depois
        log(f"  [COMANDOS] Sem contato com a nuvem: {erro}")
        return 0

    executados = 0
    for item in comandos:
        nome = item.get("comando", "")
        log(f"  [COMANDOS] Executando '{nome}' (#{item.get('id')})")

        status, resultado = executar(nome, item.get("parametros") or {})
        executados += 1

        try:
            reportar(cloud_url, api_key, item.get("id"), status, resultado)
        except Exception as erro:
            # O comando JÁ rodou. Perder o relatório deixa a tela desatualizada,
            # mas repetir a execução tiraria a loja do ar de novo — por isso não
            # há retentativa aqui: a nuvem vence o comando sozinha.
            log(f"  [COMANDOS] '{nome}' executou, mas o relatório não subiu: {erro}")

    return executados
