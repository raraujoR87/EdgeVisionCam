"""
Acesso a NPU VeriSilicon VIP9000 do Allwinner A733 pelo runtime VIPLite.

Por que este modulo existe
--------------------------
O caminho de NPU anterior fazia `import timvx` e chamava `timvx.Graph()`. Essa
API nao existe. TIM-VX e uma biblioteca C++ da VeriSilicon sem esse binding em
Python publicado, e de todo modo nao e a pilha deste SoC. Como a chamada estava
dentro de um `except ImportError` que caia para CPU, o sistema nunca acusou
nada: rodou meses em CPU relatando `ACTIVE_TIMVX` na telemetria.

A pilha real do A733, confirmada na documentacao da Radxa e no driver da
comunidade:

  - node de dispositivo : /dev/vipcore   (nao /dev/galcore)
  - modulo de kernel    : sunxi_npu
  - runtime             : VIPLite (libVIPhal.so, libNBGlinker.so), v2.0.x
  - toolchain do modelo : ONNX -> ACUITY -> NBG
  - validador de campo  : vpm_run

Estado deste modulo
-------------------
`disponivel()` e `versao()` sao completos e verificaveis: inspecionam o node, o
modulo e as bibliotecas, e dizem exatamente qual peca falta. Isso resolve o
problema imediato, que era o sistema nao saber distinguir "NPU ausente" de
"NPU presente e nao usada".

`Grafo` ainda NAO executa. As assinaturas da API C do VIPLite dependem dos
headers instalados na placa (`vip_lite.h`), e escrever ctypes por suposicao
reproduziria exatamente o defeito do `timvx`. Por isso ele falha de forma
explicita, apontando o que falta, em vez de fingir que carregou.
"""

import ctypes
import os
import subprocess

# Node criado pelo driver VIPLite. Fonte unica compartilhada com edge_hardware.
DEVICE = "/dev/vipcore"
MODULO_KERNEL = "sunxi_npu"

# Bibliotecas do runtime. libVIPhal e a camada de abstracao do hardware;
# libNBGlinker resolve o grafo binario gerado pelo ACUITY.
BIBLIOTECAS = ["libVIPhal.so", "libNBGlinker.so"]

# Locais onde o ai-sdk da Radxa instala o runtime. A lista existe porque o
# caminho varia entre imagens de sistema e versoes do SDK, e um caminho fixo
# faria a deteccao falhar numa placa perfeitamente funcional.
CAMINHOS_BUSCA = [
    "/usr/lib/aarch64-linux-gnu",
    "/usr/lib",
    "/usr/local/lib",
    "/opt/ai-sdk/lib",
    os.path.expanduser("~/ai-sdk/viplite-tina/lib/aarch64-none-linux-gnu/v2.0"),
    "/home/radxa/ai-sdk/viplite-tina/lib/aarch64-none-linux-gnu/v2.0",
]


class NpuIndisponivel(RuntimeError):
    """Levantada quando a aceleracao foi pedida e nao pode ser entregue."""


def _caminhos_de_biblioteca():
    """Diretorios a inspecionar, incluindo o que o ambiente ja aponta."""
    caminhos = list(CAMINHOS_BUSCA)
    # Ordem invertida de proposito: cada iteracao insere no inicio, entao a
    # ultima da lista acaba com a maior precedencia. VIPLITE_LIB_DIR e um
    # apontamento explicito e precisa ganhar de LD_LIBRARY_PATH, que costuma
    # trazer dezenas de diretorios sem relacao com a NPU.
    for var in ("LD_LIBRARY_PATH", "VIPLITE_LIB_DIR"):
        valor = os.environ.get(var, "")
        caminhos = [p for p in valor.split(":") if p] + caminhos
    vistos, unicos = set(), []
    for caminho in caminhos:
        if caminho not in vistos:
            vistos.add(caminho)
            unicos.append(caminho)
    return unicos


def localizar_bibliotecas():
    """
    Mapeia cada biblioteca do runtime ao caminho onde foi encontrada.

    Valor ausente significa nao encontrada — o chamador distingue "SDK nao
    instalado" de "SDK instalado parcialmente", que pedem acoes diferentes.
    """
    encontradas = {}
    for biblioteca in BIBLIOTECAS:
        encontradas[biblioteca] = None
        for diretorio in _caminhos_de_biblioteca():
            candidato = os.path.join(diretorio, biblioteca)
            if os.path.exists(candidato):
                encontradas[biblioteca] = candidato
                break
    return encontradas


def modulo_carregado():
    """Se o modulo de kernel da NPU esta carregado."""
    try:
        with open("/proc/modules", encoding="utf-8") as arquivo:
            return any(linha.startswith(MODULO_KERNEL) for linha in arquivo)
    except OSError:
        return False


def modulo_existe():
    """Se o modulo existe no kernel instalado, ainda que nao carregado."""
    try:
        raiz = os.path.join("/lib/modules", os.uname().release)
    except OSError:
        return False
    for pasta, _, arquivos in os.walk(raiz):
        for arquivo in arquivos:
            if arquivo.startswith(MODULO_KERNEL):
                return True
    return False


def disponivel():
    """
    Se a NPU pode ser usada, e por que nao quando nao pode.

    Devolve (bool, motivo). O motivo e escrito para virar log de appliance: cada
    causa tem uma acao diferente, e "nao funcionou" nao ajuda ninguem em campo.
    """
    if not os.path.exists(DEVICE):
        if modulo_existe() and not modulo_carregado():
            return False, (
                f"{DEVICE} ausente, mas o modulo {MODULO_KERNEL} existe neste "
                f"kernel. Carregue com: sudo modprobe {MODULO_KERNEL}"
            )
        return False, (
            f"{DEVICE} ausente e nenhum modulo {MODULO_KERNEL} neste kernel. "
            "A NPU depende da imagem de sistema da Radxa com o driver VIPLite."
        )

    if not os.access(DEVICE, os.R_OK | os.W_OK):
        return False, (
            f"{DEVICE} existe mas sem permissao de leitura/escrita. Em container, "
            f"declare o device; no host, verifique o grupo dono de {DEVICE}."
        )

    bibliotecas = localizar_bibliotecas()
    faltando = [nome for nome, caminho in bibliotecas.items() if caminho is None]
    if faltando:
        return False, (
            f"Runtime VIPLite incompleto: {', '.join(faltando)} nao encontrada(s). "
            "Instale o ai-sdk da Radxa (make AI_SDK_PLATFORM=a733 NPU_SW_VERSION=v2.0) "
            "e aponte VIPLITE_LIB_DIR para a pasta lib."
        )

    return True, "VIPLite pronto."


def versao():
    """
    Versao do driver VIPLite, ou uma descricao do porque nao foi possivel ler.

    A versao importa: um NBG compilado por um ACUITY de versao diferente da do
    driver e recusado no carregamento, e a mensagem do runtime nao deixa claro
    que a causa e incompatibilidade de versao.
    """
    try:
        saida = subprocess.run(
            ["vpm_run", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        texto = (saida.stdout + saida.stderr).strip()
        for linha in texto.splitlines():
            if "version" in linha.lower():
                return linha.strip()
        if texto:
            return texto.splitlines()[0]
    except (OSError, subprocess.SubprocessError):
        pass

    bibliotecas = localizar_bibliotecas()
    caminho = bibliotecas.get("libVIPhal.so")
    if caminho:
        return f"desconhecida (libVIPhal.so em {caminho})"
    return "desconhecida"


class Grafo:
    """
    Grafo NBG carregado na NPU.

    NAO IMPLEMENTADO. Ver o cabecalho do modulo: as assinaturas da API C do
    VIPLite vem de `vip_lite.h`, instalado na placa junto com o ai-sdk. Escrever
    o binding sem esses headers seria adivinhar tipos e ordem de argumentos —
    e adivinhar foi exatamente o que produziu o `timvx.Graph()` que nunca
    executou. Um binding errado em ctypes nao falha no import: corrompe memoria
    ou devolve tensores silenciosamente invalidos, que e pior que nao ter.

    Para completar:
      1. bash deploy/npu_diagnostico.sh   (coleta headers, libs e versao)
      2. as assinaturas saem de vip_lite.h; o fluxo e
         vip_init -> vip_create_network -> vip_prepare_network ->
         vip_set_input/output -> vip_run_network -> vip_finish
    """

    def __init__(self, caminho_nbg):
        self.caminho_nbg = caminho_nbg
        self.inputs = []
        self.outputs = []

        disponivel_agora, motivo = disponivel()
        if not disponivel_agora:
            raise NpuIndisponivel(motivo)

        raise NpuIndisponivel(
            "Binding VIPLite ainda nao implementado — faltam os headers da placa. "
            "Rode 'bash deploy/npu_diagnostico.sh' e forneca a saida. "
            "Ate la, use POSE_MODEL_PATH=*.pt para rodar em CPU conscientemente."
        )

    def run(self):
        raise NpuIndisponivel("Binding VIPLite ainda nao implementado.")


def carregar_biblioteca():
    """
    Abre libVIPhal.so e devolve o handle ctypes.

    Separado de `Grafo` porque e util isoladamente: confirma que a biblioteca
    encontrada realmente carrega neste sistema — arquitetura, dependencias e
    versao do glibc — antes de qualquer tentativa de inferencia.
    """
    caminho = localizar_bibliotecas().get("libVIPhal.so")
    if not caminho:
        raise NpuIndisponivel("libVIPhal.so nao encontrada.")
    try:
        return ctypes.CDLL(caminho)
    except OSError as erro:
        raise NpuIndisponivel(f"libVIPhal.so encontrada mas nao carregavel: {erro}") from erro
