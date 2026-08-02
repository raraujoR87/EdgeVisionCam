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

Origem das assinaturas
----------------------
Tudo o que este modulo declara em ctypes foi transcrito de `vip_lite.h` e
`vip_lite_common.h` do ai-sdk (viplite-tina, v2.0, aarch64-none-linux-gnu), e a
ordem das chamadas segue `examples/vpm_run/vpm_run.c` do mesmo SDK. Nada aqui
foi inferido: um binding ctypes errado nao falha no import — devolve tensores
invalidos, e num sistema antifurto "nenhuma pessoa detectada" e o pior modo de
falha que existe.

Ao atualizar o ai-sdk, reconfira os enums em `vip_lite.h`. Eles sao valores
numericos: uma renumeracao entre versoes passa silenciosamente.
"""

import ctypes
import os
import subprocess

# numpy NAO e importado no topo de proposito. A deteccao (`disponivel`,
# `localizar_bibliotecas`, `carregar_biblioteca`) precisa rodar no python3 do
# sistema, onde numpy nao esta instalado — ele vive dentro do container do
# appliance. Importar no topo fazia o instalador do runtime quebrar com
# ModuleNotFoundError num ponto em que a NPU estava perfeitamente configurada.
# Quem executa grafo (Tensor, Grafo) importa sob demanda.


def _np():
    import numpy
    return numpy

# Node criado pelo driver VIPLite. Fonte unica compartilhada com edge_hardware.
DEVICE = "/dev/vipcore"

# O nome do modulo varia por BSP: `vipcore` na imagem da Radxa para o A733,
# `sunxi_npu` em builds da Allwinner e em outras placas. Verificar so um nome
# reporta "modulo ausente" numa placa cujo driver esta carregado — foi o que
# aconteceu na primeira rodada de diagnostico deste appliance.
MODULOS_KERNEL = ["vipcore", "sunxi_npu"]
MODULO_KERNEL = MODULOS_KERNEL[0]

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
    """Nome do modulo da NPU carregado, ou None."""
    try:
        with open("/proc/modules", encoding="utf-8") as arquivo:
            carregados = {linha.split()[0] for linha in arquivo if linha.split()}
    except OSError:
        return None
    for nome in MODULOS_KERNEL:
        if nome in carregados:
            return nome
    return None


def modulo_existe():
    """Se algum modulo da NPU existe no kernel instalado, ainda que descarregado."""
    try:
        raiz = os.path.join("/lib/modules", os.uname().release)
    except OSError:
        return False
    for _, _, arquivos in os.walk(raiz):
        for arquivo in arquivos:
            if any(arquivo.startswith(nome) for nome in MODULOS_KERNEL):
                return True
    return False


def disponivel():
    """
    Se a NPU pode ser usada, e por que nao quando nao pode.

    Devolve (bool, motivo). O motivo e escrito para virar log de appliance: cada
    causa tem uma acao diferente, e "nao funcionou" nao ajuda ninguem em campo.
    """
    nomes = " ou ".join(MODULOS_KERNEL)
    if not os.path.exists(DEVICE):
        if modulo_existe() and not modulo_carregado():
            return False, (
                f"{DEVICE} ausente, mas o modulo da NPU existe neste kernel. "
                f"Carregue com: sudo modprobe {MODULOS_KERNEL[0]} "
                f"(nomes possiveis: {nomes})"
            )
        return False, (
            f"{DEVICE} ausente e nenhum modulo {nomes} neste kernel. "
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
    # O vpm_run nao tem flag de versao (so -h): passar --version faz ele imprimir
    # a ajuda inteira. Por isso filtramos por linhas que realmente parecam uma
    # versao, em vez de aceitar a primeira linha da saida — devolver texto de
    # ajuda como "versao do driver" seria pior que admitir desconhecimento.
    try:
        saida = subprocess.run(
            ["vpm_run", "-h"],
            capture_output=True, text=True, timeout=10,
        )
        for linha in (saida.stdout + saida.stderr).splitlines():
            if "driver" in linha.lower() and "version" in linha.lower():
                return linha.strip()
    except (OSError, subprocess.SubprocessError):
        pass

    bibliotecas = localizar_bibliotecas()
    caminho = bibliotecas.get("libVIPhal.so")
    if caminho:
        return f"desconhecida (libVIPhal.so em {caminho})"
    return "desconhecida"


# ── Constantes de vip_lite.h ───────────────────────────────────────
# Transcritas do header do ai-sdk (viplite-tina, v2.0, aarch64-none-linux-gnu).
# Valores errados aqui nao geram excecao: produzem tensores invalidos, que num
# antifurto significa "nenhuma pessoa detectada". Por isso ficam nomeados e
# isolados, em vez de literais espalhados pelas chamadas.

VIP_SUCCESS = 0

VIP_CREATE_NETWORK_FROM_FILE = 0x01

# vip_network_property_e
PROP_INPUT_COUNT = 1
PROP_OUTPUT_COUNT = 2

# vip_buffer_property_e
PROP_QUANT_FORMAT = 0
PROP_NUM_OF_DIMENSION = 1
PROP_SIZES_OF_DIMENSION = 2
PROP_DATA_FORMAT = 3
PROP_FIXED_POINT_POS = 4
PROP_TF_SCALE = 5
PROP_TF_ZERO_POINT = 6

# vip_buffer_quantize_format_e
QUANT_NONE = 0
QUANT_DYNAMIC_FIXED_POINT = 1
QUANT_TF_ASYMM = 2

# vip_buffer_format_e -> dtype numpy correspondente
# Nomes, nao tipos numpy: assim a tabela existe sem numpy carregado.
FORMATOS = {
    0: "float32", 1: "float16", 2: "uint8", 3: "int8",
    4: "uint16", 5: "int16", 8: "int32", 9: "uint32",
}

MAX_DIMS = 6  # sizes[6] em vip_buffer_create_params_t


class _QuantDfp(ctypes.Structure):
    _fields_ = [("fixed_point_pos", ctypes.c_int32)]


class _QuantAffine(ctypes.Structure):
    _fields_ = [("scale", ctypes.c_float), ("zeroPoint", ctypes.c_int32)]


class _QuantData(ctypes.Union):
    _fields_ = [("dfp", _QuantDfp), ("affine", _QuantAffine)]


class BufferCreateParams(ctypes.Structure):
    """Espelha vip_buffer_create_params_t. A ordem dos campos e o contrato."""
    _fields_ = [
        ("num_of_dims", ctypes.c_uint32),
        ("sizes", ctypes.c_uint32 * MAX_DIMS),
        ("data_format", ctypes.c_int32),   # vip_enum == vip_int32_t
        ("quant_format", ctypes.c_int32),
        ("quant_data", _QuantData),
        ("memory_type", ctypes.c_uint32),
    ]


class Tensor:
    """Descricao de um tensor de entrada ou saida do grafo."""

    def __init__(self, indice, formato, dims, quant_format, escala, zero_point, fixed_point):
        self.indice = indice
        self.formato = formato
        self.dims = dims
        self.quant_format = quant_format
        self.escala = escala
        self.zero_point = zero_point
        self.fixed_point = fixed_point
        self.dtype = _np().dtype(FORMATOS.get(formato, "uint8"))
        self.buffer = None

    @property
    def elementos(self):
        total = 1
        for d in self.dims:
            total *= d
        return total

    def quantizar(self, dados):
        """
        float32 -> formato do tensor.

        O ACUITY quantiza a entrada; alimentar float cru num tensor uint8
        assimetrico produz lixo sem erro nenhum.
        """
        if self.quant_format == QUANT_TF_ASYMM and self.escala:
            valores = dados / self.escala + self.zero_point
        elif self.quant_format == QUANT_DYNAMIC_FIXED_POINT:
            valores = dados * (2.0 ** self.fixed_point)
        else:
            return dados.astype(self.dtype, copy=False)

        np = _np()
        info = np.iinfo(self.dtype) if np.issubdtype(self.dtype, np.integer) else None
        if info is not None:
            valores = np.clip(np.round(valores), info.min, info.max)
        return valores.astype(self.dtype, copy=False)

    def desquantizar(self, dados):
        """Formato do tensor -> float32, para o decodificador YOLO."""
        np = _np()
        if self.quant_format == QUANT_TF_ASYMM and self.escala:
            return (dados.astype(np.float32) - self.zero_point) * self.escala
        if self.quant_format == QUANT_DYNAMIC_FIXED_POINT:
            return dados.astype(np.float32) / (2.0 ** self.fixed_point)
        return dados.astype(np.float32, copy=False)


class Grafo:
    """
    Grafo NBG carregado e executado na NPU pelo runtime VIPLite.

    Sequencia de chamadas, conforme vip_lite.h e o exemplo vpm_run.c do ai-sdk:

        vip_init
        vip_create_network(caminho, 0, FROM_FILE)
        vip_query_network(INPUT_COUNT / OUTPUT_COUNT)
        vip_query_input/output  -> monta vip_buffer_create_params_t
        vip_create_buffer       -> um por tensor
        vip_prepare_network     -> DEPOIS de criar os buffers
        vip_map_buffer          -> escreve a entrada
        vip_set_input/output
        vip_run_network
        vip_map_buffer          -> le a saida

    A ordem nao e estilistica: `vip_prepare_network` aloca a memoria interna a
    partir dos buffers ja registrados, e prepara-lo antes deixa o grafo sem
    onde escrever.
    """

    def __init__(self, caminho_nbg):
        self.caminho_nbg = caminho_nbg
        self.inputs = []
        self.outputs = []
        self._rede = None
        self._preparado = False

        disponivel_agora, motivo = disponivel()
        if not disponivel_agora:
            raise NpuIndisponivel(motivo)

        self._lib = carregar_biblioteca()
        self._declarar_assinaturas()
        self._verificar(self._lib.vip_init(), "vip_init")

        try:
            self._criar_rede()
            self._mapear_tensores()
            self._verificar(self._lib.vip_prepare_network(self._rede), "vip_prepare_network")
            self._preparado = True
            self._registrar_buffers()
        except Exception:
            # Sem isto, uma falha no meio da montagem deixaria a NPU com a rede
            # meio criada e o proximo processo receberia VIP_ERROR_OUT_OF_MEMORY.
            self.fechar()
            raise

    # ── Ligacao com a biblioteca ──────────────────────────────────
    def _declarar_assinaturas(self):
        lib = self._lib
        c_uint32_p = ctypes.POINTER(ctypes.c_uint32)

        lib.vip_init.restype = ctypes.c_int32
        lib.vip_init.argtypes = []
        lib.vip_destroy.restype = ctypes.c_int32
        lib.vip_destroy.argtypes = []

        lib.vip_create_network.restype = ctypes.c_int32
        lib.vip_create_network.argtypes = [
            ctypes.c_char_p, ctypes.c_uint32, ctypes.c_int32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.vip_destroy_network.restype = ctypes.c_int32
        lib.vip_destroy_network.argtypes = [ctypes.c_void_p]
        lib.vip_prepare_network.restype = ctypes.c_int32
        lib.vip_prepare_network.argtypes = [ctypes.c_void_p]
        lib.vip_finish_network.restype = ctypes.c_int32
        lib.vip_finish_network.argtypes = [ctypes.c_void_p]
        lib.vip_run_network.restype = ctypes.c_int32
        lib.vip_run_network.argtypes = [ctypes.c_void_p]

        lib.vip_query_network.restype = ctypes.c_int32
        lib.vip_query_network.argtypes = [ctypes.c_void_p, ctypes.c_int32, ctypes.c_void_p]
        for nome in ("vip_query_input", "vip_query_output"):
            fn = getattr(lib, nome)
            fn.restype = ctypes.c_int32
            fn.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32, ctypes.c_void_p]

        lib.vip_create_buffer.restype = ctypes.c_int32
        lib.vip_create_buffer.argtypes = [
            ctypes.POINTER(BufferCreateParams), ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.vip_destroy_buffer.restype = ctypes.c_int32
        lib.vip_destroy_buffer.argtypes = [ctypes.c_void_p]
        lib.vip_map_buffer.restype = ctypes.c_void_p
        lib.vip_map_buffer.argtypes = [ctypes.c_void_p]
        lib.vip_unmap_buffer.restype = ctypes.c_int32
        lib.vip_unmap_buffer.argtypes = [ctypes.c_void_p]

        for nome in ("vip_set_input", "vip_set_output"):
            fn = getattr(lib, nome)
            fn.restype = ctypes.c_int32
            fn.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]

        self._c_uint32_p = c_uint32_p

    @staticmethod
    def _verificar(status, operacao):
        if status != VIP_SUCCESS:
            raise NpuIndisponivel(f"{operacao} falhou com status {status}")

    # ── Montagem ──────────────────────────────────────────────────
    def _criar_rede(self):
        rede = ctypes.c_void_p()
        self._verificar(
            self._lib.vip_create_network(
                self.caminho_nbg.encode("utf-8"), 0,
                VIP_CREATE_NETWORK_FROM_FILE, ctypes.byref(rede),
            ),
            "vip_create_network",
        )
        self._rede = rede

    def _contar(self, propriedade):
        valor = ctypes.c_uint32()
        self._verificar(
            self._lib.vip_query_network(self._rede, propriedade, ctypes.byref(valor)),
            f"vip_query_network({propriedade})",
        )
        return valor.value

    def _descrever(self, indice, entrada):
        consultar = self._lib.vip_query_input if entrada else self._lib.vip_query_output

        formato = ctypes.c_int32()
        num_dims = ctypes.c_uint32()
        quant = ctypes.c_int32()
        sizes = (ctypes.c_uint32 * MAX_DIMS)()

        consultar(self._rede, indice, PROP_DATA_FORMAT, ctypes.byref(formato))
        consultar(self._rede, indice, PROP_NUM_OF_DIMENSION, ctypes.byref(num_dims))
        consultar(self._rede, indice, PROP_SIZES_OF_DIMENSION, sizes)
        consultar(self._rede, indice, PROP_QUANT_FORMAT, ctypes.byref(quant))

        escala, zero_point, fixed = 1.0, 0, 0
        if quant.value == QUANT_TF_ASYMM:
            c_escala = ctypes.c_float()
            c_zero = ctypes.c_int32()
            consultar(self._rede, indice, PROP_TF_SCALE, ctypes.byref(c_escala))
            consultar(self._rede, indice, PROP_TF_ZERO_POINT, ctypes.byref(c_zero))
            escala, zero_point = c_escala.value, c_zero.value
        elif quant.value == QUANT_DYNAMIC_FIXED_POINT:
            c_fixed = ctypes.c_uint8()
            consultar(self._rede, indice, PROP_FIXED_POINT_POS, ctypes.byref(c_fixed))
            fixed = c_fixed.value

        dims = [sizes[i] for i in range(num_dims.value)]
        return Tensor(indice, formato.value, dims, quant.value, escala, zero_point, fixed)

    def _mapear_tensores(self):
        for indice in range(self._contar(PROP_INPUT_COUNT)):
            self.inputs.append(self._alocar(self._descrever(indice, entrada=True)))
        for indice in range(self._contar(PROP_OUTPUT_COUNT)):
            self.outputs.append(self._alocar(self._descrever(indice, entrada=False)))

    def _alocar(self, tensor):
        params = BufferCreateParams()
        params.num_of_dims = len(tensor.dims)
        for i, tamanho in enumerate(tensor.dims):
            params.sizes[i] = tamanho
        params.data_format = tensor.formato
        params.quant_format = tensor.quant_format
        if tensor.quant_format == QUANT_TF_ASYMM:
            params.quant_data.affine.scale = tensor.escala
            params.quant_data.affine.zeroPoint = tensor.zero_point
        elif tensor.quant_format == QUANT_DYNAMIC_FIXED_POINT:
            params.quant_data.dfp.fixed_point_pos = tensor.fixed_point
        params.memory_type = 0  # VIP_BUFFER_MEMORY_TYPE_DEFAULT

        buffer = ctypes.c_void_p()
        self._verificar(
            self._lib.vip_create_buffer(
                ctypes.byref(params), ctypes.sizeof(params), ctypes.byref(buffer)
            ),
            f"vip_create_buffer(tensor {tensor.indice})",
        )
        tensor.buffer = buffer
        return tensor

    def _registrar_buffers(self):
        for tensor in self.inputs:
            self._verificar(
                self._lib.vip_set_input(self._rede, tensor.indice, tensor.buffer),
                f"vip_set_input({tensor.indice})",
            )
        for tensor in self.outputs:
            self._verificar(
                self._lib.vip_set_output(self._rede, tensor.indice, tensor.buffer),
                f"vip_set_output({tensor.indice})",
            )

    # ── Execucao ──────────────────────────────────────────────────
    def escrever_entrada(self, dados, indice=0):
        """Copia `dados` (float32) para o buffer de entrada, quantizando."""
        tensor = self.inputs[indice]
        np = _np()
        quantizado = tensor.quantizar(np.ascontiguousarray(dados, dtype=np.float32))
        if quantizado.size != tensor.elementos:
            raise NpuIndisponivel(
                f"Entrada com {quantizado.size} elementos; o grafo espera "
                f"{tensor.elementos} (dims {tensor.dims}). Verifique o imgsz do export ONNX."
            )
        destino = self._lib.vip_map_buffer(tensor.buffer)
        if not destino:
            raise NpuIndisponivel(f"vip_map_buffer falhou na entrada {indice}")
        ctypes.memmove(destino, quantizado.ctypes.data, quantizado.nbytes)
        self._lib.vip_unmap_buffer(tensor.buffer)

    def ler_saida(self, indice=0):
        """Le o buffer de saida e desquantiza para float32."""
        tensor = self.outputs[indice]
        origem = self._lib.vip_map_buffer(tensor.buffer)
        if not origem:
            raise NpuIndisponivel(f"vip_map_buffer falhou na saida {indice}")
        np = _np()
        bruto = np.ctypeslib.as_array(
            ctypes.cast(origem, ctypes.POINTER(ctypes.c_uint8)),
            shape=(tensor.elementos * np.dtype(tensor.dtype).itemsize,),
        )
        # copy() antes do unmap: as_array devolve uma view da memoria mapeada,
        # que deixa de ser valida assim que o buffer e desmapeado.
        # tensor.dims de C vem como [fastest, ..., slowest] (ex: W, H, C, N).
        # O NumPy espera (slowest, ..., fastest), entao revertemos a lista.
        dados = bruto.view(tensor.dtype).reshape(tensor.dims[::-1]).copy()
        self._lib.vip_unmap_buffer(tensor.buffer)
        return tensor.desquantizar(dados)

    def run(self):
        if not self._preparado:
            raise NpuIndisponivel("Grafo nao preparado.")
        self._verificar(self._lib.vip_run_network(self._rede), "vip_run_network")

    def inferir(self, entrada):
        """Executa um ciclo completo e devolve a lista de tensores de saida."""
        self.escrever_entrada(entrada)
        self.run()
        return [self.ler_saida(i) for i in range(len(self.outputs))]

    # ── Liberacao ─────────────────────────────────────────────────
    def fechar(self):
        """
        Libera rede, buffers e o driver.

        Um appliance reinicia a engine sem reiniciar o processo (troca de
        modelo, recuperacao de erro). Sem liberar, cada ciclo vaza memoria da
        NPU ate o `vip_create_network` seguinte falhar por falta de recurso —
        falha que aparece dias depois e sem relacao aparente com a causa.
        """
        lib = getattr(self, "_lib", None)
        if lib is None:
            return
        for tensor in self.inputs + self.outputs:
            if tensor.buffer:
                lib.vip_destroy_buffer(tensor.buffer)
                tensor.buffer = None
        if self._rede:
            if self._preparado:
                lib.vip_finish_network(self._rede)
                self._preparado = False
            lib.vip_destroy_network(self._rede)
            self._rede = None
        lib.vip_destroy()
        self._lib = None

    def __del__(self):
        try:
            self.fechar()
        except Exception:
            pass


def carregar_biblioteca():
    """
    Abre libNBGlinker.so (ou libVIPhal.so) e devolve o handle ctypes.

    Separado de `Grafo` porque e util isoladamente: confirma que a biblioteca
    encontrada realmente carrega neste sistema — arquitetura, dependencias e
    versao do glibc — antes de qualquer tentativa de inferencia.
    """
    libs = localizar_bibliotecas()
    
    linker_caminho = libs.get("libNBGlinker.so")
    if linker_caminho:
        try:
            # Em alguns SDKs (ex. Radxa a733), os simbolos vip_* publicos estao no linker.
            # E necessario que LD_LIBRARY_PATH contenha a pasta para resolver libVIPhal.so
            return ctypes.CDLL(linker_caminho)
        except OSError as erro:
            raise NpuIndisponivel(f"libNBGlinker.so encontrada mas nao carregavel: {erro}") from erro

    caminho = libs.get("libVIPhal.so")
    if not caminho:
        raise NpuIndisponivel("Nenhuma biblioteca VIPLite (libNBGlinker/libVIPhal) encontrada.")
    try:
        return ctypes.CDLL(caminho)
    except OSError as erro:
        raise NpuIndisponivel(f"libVIPhal.so encontrada mas nao carregavel: {erro}") from erro
