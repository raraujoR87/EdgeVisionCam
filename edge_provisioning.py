"""
Resgate do código de provisionamento junto à nuvem.

Substitui o que o técnico digitava à mão na instalação — usuário e senha do
Docker Hub, Edge key do Portainer, chave da loja. Além de lento e sujeito a
erro de transcrição, aquele fluxo espalhava credenciais de produção por quem
quer que fizesse a instalação, e nada ligava o appliance a uma loja.

Agora ele digita só o código curto emitido no console. Este módulo troca esse
código pela configuração real e a grava no `.env` que o Compose consome.
"""

import json
import os
import re
import urllib.error
import urllib.request

CLOUD_URL_PADRAO = os.getenv("CLOUD_URL", "https://visioncam-cloud.vercel.app")
TIMEOUT_SEGUNDOS = 20

ARQUIVO_ENV = ".env"

# Mesmo alfabeto do gerador na nuvem (ui/app/api/provisioning/codigo.ts).
# Sem 0/O, 1/I/L, 2/Z, 5/S, 8/B — os pares que geram erro de transcrição.
ALFABETO = "34679ACDEFGHJKMNPQRTUVWXY"


class ErroDeProvisionamento(RuntimeError):
    """Falha ao resgatar o código. A mensagem é exibida ao técnico."""


def normalizar_codigo(entrada: str) -> str:
    """
    Aceita minúsculas, espaços e hífen ausente.

    Quem digita numa tela de celular dentro de uma loja não deve ser punido por
    formatação — e um código recusado por causa de um espaço vira chamado.
    """
    limpo = re.sub(r"[^A-Z0-9]", "", (entrada or "").upper())
    if len(limpo) != 8:
        return ""
    return f"{limpo[:4]}-{limpo[4:]}"


def codigo_valido(entrada: str) -> bool:
    normalizado = normalizar_codigo(entrada)
    if not normalizado:
        return False
    return all(c in ALFABETO for c in normalizado.replace("-", ""))


def resgatar(codigo: str, cloud_url: str = None) -> dict:
    """
    Troca o código pela configuração da loja.

    O código é de uso único: uma segunda tentativa com o mesmo valor falha. Por
    isso o chamador deve gravar o resultado antes de qualquer passo que possa
    abortar a instalação.
    """
    if not codigo_valido(codigo):
        raise ErroDeProvisionamento(
            "Código inválido. Confira os 8 caracteres — o código não usa "
            "0, O, 1, I, L, 2, Z, 5, S nem 8."
        )

    base = (cloud_url or CLOUD_URL_PADRAO).rstrip("/")
    url = f"{base}/api/provisioning/claim"
    corpo = json.dumps({"codigo": normalizar_codigo(codigo)}).encode("utf-8")

    requisicao = urllib.request.Request(
        url, data=corpo, headers={"Content-Type": "application/json"}, method="POST"
    )

    try:
        with urllib.request.urlopen(requisicao, timeout=TIMEOUT_SEGUNDOS) as resposta:
            dados = json.loads(resposta.read().decode("utf-8"))
    except urllib.error.HTTPError as erro:
        try:
            detalhe = json.loads(erro.read().decode("utf-8")).get("error", "")
        except Exception:
            detalhe = ""
        # A nuvem responde igual para código inexistente, já usado, revogado e
        # vencido — de propósito. Traduzimos para algo acionável sem inventar
        # uma causa que o servidor não informou.
        raise ErroDeProvisionamento(
            detalhe or f"A nuvem recusou o código (HTTP {erro.code}). "
            "Ele pode já ter sido usado, vencido ou revogado — emita outro no console."
        )
    except urllib.error.URLError as erro:
        raise ErroDeProvisionamento(
            f"Não foi possível falar com a nuvem em {base}: {erro.reason}. "
            "Confira o cabo de rede e o acesso à internet da loja."
        )

    if dados.get("status") != "success":
        raise ErroDeProvisionamento("Resposta inesperada da nuvem.")

    return dados


def gravar_env(config: dict, cloud_url: str = None, caminho: str = ARQUIVO_ENV) -> dict:
    """
    Grava o `.env` que o docker-compose.yml consome.

    Preserva variáveis já presentes que não sejam gerenciadas pelo
    provisionamento — TZ e o caminho do modelo NPU são ajustados na placa e não
    devem sumir numa reinstalação.
    """
    loja = config.get("store", {})
    deploy = config.get("deploy", {})

    gerenciadas = {
        "VISIONCAM_TAG": deploy.get("version") or "latest",
        "CLOUD_API_URL": (cloud_url or CLOUD_URL_PADRAO).rstrip("/"),
        "STORE_API_KEY": loja.get("api_key", ""),
        "STORE_NAME": loja.get("name", ""),
        "EDGE_KEY": deploy.get("edge_key", ""),
    }

    preservadas = []
    if os.path.exists(caminho):
        with open(caminho, encoding="utf-8") as arquivo:
            for linha in arquivo:
                chave = linha.split("=", 1)[0].strip()
                if chave and chave not in gerenciadas and not linha.startswith("#"):
                    preservadas.append(linha.rstrip("\n"))

    with open(caminho, "w", encoding="utf-8") as arquivo:
        arquivo.write("# Gerado pelo provisionamento. Editar à mão é possível,\n")
        arquivo.write("# mas uma nova instalação sobrescreve as linhas abaixo.\n")
        for chave, valor in gerenciadas.items():
            arquivo.write(f"{chave}={valor}\n")
        if preservadas:
            arquivo.write("\n# Ajustes locais preservados:\n")
            for linha in preservadas:
                arquivo.write(linha + "\n")

    return gerenciadas
