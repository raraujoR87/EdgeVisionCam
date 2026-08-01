"""
Testes da detecção da NPU VIPLite.

O defeito que estes testes travam já custou meses: o sistema reportava
aceleração ativa enquanto rodava em CPU, porque procurava o device errado e
porque a falha de carregamento era engolida por um `except ImportError`.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import edge_hardware as hw  # noqa: E402
from edge import viplite  # noqa: E402


# ── O device correto ───────────────────────────────────────────────

def test_device_e_vipcore_nao_galcore():
    """
    O A733 usa VeriSilicon VIPLite, cujo node é /dev/vipcore. /dev/galcore é a
    pilha Vivante clássica de OUTROS SoCs — procurá-lo devolve "NPU ausente"
    numa placa cuja NPU funciona.
    """
    assert viplite.DEVICE == "/dev/vipcore"
    # O nome do módulo varia por BSP; ambos precisam ser aceitos.
    assert "vipcore" in viplite.MODULOS_KERNEL
    assert "sunxi_npu" in viplite.MODULOS_KERNEL


def test_edge_hardware_usa_o_mesmo_device():
    """
    Se os dois divergirem, o container sobe sem o device montado e a engine
    reporta NPU ativa: exatamente o estado que não se percebe pelo painel.
    """
    assert hw.NPU_DEVICE == viplite.DEVICE
    assert hw.NPU_MODULO == viplite.MODULO_KERNEL
    assert any(caminho == viplite.DEVICE for caminho, _ in hw.DEVICES_OPCIONAIS)


def test_nenhuma_referencia_a_timvx_no_codigo():
    """
    `import timvx` era uma API inventada: TIM-VX é uma biblioteca C++ sem esse
    binding em Python, e não é a pilha deste SoC. Deixá-la voltar traria de
    volta o fallback silencioso.
    """
    import re

    # Só linhas de código: os comentários que explicam por que o timvx saiu
    # precisam continuar mencionando o nome.
    importa_timvx = re.compile(r"^\s*(import\s+timvx|from\s+timvx\b)", re.MULTILINE)

    raiz = os.path.join(os.path.dirname(__file__), "..")
    for pasta in ("edge", "core", "shared"):
        for pasta_atual, _, arquivos in os.walk(os.path.join(raiz, pasta)):
            for arquivo in arquivos:
                if not arquivo.endswith(".py"):
                    continue
                caminho = os.path.join(pasta_atual, arquivo)
                with open(caminho, encoding="utf-8") as f:
                    assert not importa_timvx.search(f.read()), f"{caminho} voltou a importar timvx"


# ── Diagnóstico honesto ────────────────────────────────────────────

def test_ausencia_do_device_e_reportada_com_a_acao(monkeypatch):
    """
    "SDK não instalado" não distingue driver ausente de biblioteca faltando —
    e as duas exigem ações completamente diferentes em campo.
    """
    monkeypatch.setattr(viplite.os.path, "exists", lambda caminho: False)
    monkeypatch.setattr(viplite, "modulo_existe", lambda: False)

    disponivel, motivo = viplite.disponivel()

    assert not disponivel
    assert "vipcore" in motivo
    assert "sunxi_npu" in motivo  # ambos os nomes de módulo citados


def test_modulo_presente_mas_descarregado_sugere_modprobe(monkeypatch):
    """
    É a diferença entre 'trocar a imagem do sistema' e 'rodar um comando'."""
    monkeypatch.setattr(viplite.os.path, "exists", lambda caminho: False)
    monkeypatch.setattr(viplite, "modulo_existe", lambda: True)
    monkeypatch.setattr(viplite, "modulo_carregado", lambda: False)

    disponivel, motivo = viplite.disponivel()

    assert not disponivel
    assert "modprobe vipcore" in motivo
    assert "sunxi_npu" in motivo  # o nome alternativo também é oferecido


def test_biblioteca_faltando_e_nomeada(monkeypatch, tmp_path):
    """Saber QUAL biblioteca falta evita reinstalar o SDK inteiro às cegas."""
    device = tmp_path / "vipcore"
    device.write_text("")
    monkeypatch.setattr(viplite, "DEVICE", str(device))
    monkeypatch.setattr(viplite, "localizar_bibliotecas",
                        lambda: {"libVIPhal.so": "/usr/lib/libVIPhal.so", "libNBGlinker.so": None})

    disponivel, motivo = viplite.disponivel()

    assert not disponivel
    assert "libNBGlinker.so" in motivo
    assert "libVIPhal.so" not in motivo


def test_tudo_presente_e_reportado_como_pronto(monkeypatch, tmp_path):
    device = tmp_path / "vipcore"
    device.write_text("")
    monkeypatch.setattr(viplite, "DEVICE", str(device))
    monkeypatch.setattr(viplite, "localizar_bibliotecas",
                        lambda: {b: f"/usr/lib/{b}" for b in viplite.BIBLIOTECAS})

    disponivel, motivo = viplite.disponivel()

    assert disponivel
    assert "pronto" in motivo.lower()


# ── Falha explícita em vez de silenciosa ───────────────────────────

def test_grafo_falha_explicitamente_sem_npu(monkeypatch):
    """
    O modo antigo caía para CPU em silêncio. Falhar alto é o que permite ao
    chamador decidir — e ao operador saber que a aceleração não está valendo.
    """
    monkeypatch.setattr(viplite, "disponivel", lambda: (False, "device ausente"))

    with pytest.raises(viplite.NpuIndisponivel, match="device ausente"):
        viplite.Grafo("modelo.nbg")


def test_grafo_propaga_falha_da_biblioteca(monkeypatch):
    """
    Uma biblioteca presente mas não carregável (ABI errada, dependência
    faltando) precisa falhar alto. Silenciar aqui devolveria um grafo inerte
    que produz "nenhuma pessoa detectada" — o pior modo de falha num antifurto.
    """
    monkeypatch.setattr(viplite, "disponivel", lambda: (True, "ok"))
    monkeypatch.setattr(viplite, "carregar_biblioteca",
                        lambda: (_ for _ in ()).throw(viplite.NpuIndisponivel("ABI incompatível")))

    with pytest.raises(viplite.NpuIndisponivel, match="ABI"):
        viplite.Grafo("modelo.nbg")


def test_engine_cai_para_cpu_sem_quebrar(monkeypatch):
    """
    Falhar alto no binding não pode derrubar o appliance: sem NPU o sistema
    ainda precisa detectar, mesmo mais devagar.
    """
    from edge import vivante_pose_engine as vpe

    monkeypatch.setattr(viplite, "disponivel", lambda: (False, "sem driver"))
    chamou = {}
    monkeypatch.setattr(vpe.VivantePoseEngine, "fallback_to_pytorch",
                        lambda self: chamou.setdefault("sim", True))

    engine = vpe.VivantePoseEngine("modelo.nbg")

    assert chamou.get("sim")
    assert not engine.is_npu


# ── Variáveis de ambiente ──────────────────────────────────────────

def test_caminho_do_ambiente_tem_precedencia(monkeypatch):
    """
    O ai-sdk é instalado em lugares diferentes conforme a imagem de sistema.
    Sem respeitar VIPLITE_LIB_DIR, uma instalação válida seria ignorada.
    """
    monkeypatch.setenv("VIPLITE_LIB_DIR", "/caminho/customizado")
    caminhos = viplite._caminhos_de_biblioteca()
    assert caminhos[0] == "/caminho/customizado"


# ── Estrutura em ctypes ────────────────────────────────────────────
# Erro aqui não levanta exceção: produz tensores inválidos. Num antifurto isso
# vira "nenhuma pessoa detectada", que é indistinguível de operação normal.

def test_layout_de_buffer_create_params():
    """
    Espelha vip_buffer_create_params_t. Campo fora de ordem ou tipo errado faz
    a NPU ler dimensões de onde está a escala de quantização.
    """
    import ctypes

    campos = [nome for nome, _ in viplite.BufferCreateParams._fields_]
    assert campos == [
        "num_of_dims", "sizes", "data_format",
        "quant_format", "quant_data", "memory_type",
    ]

    params = viplite.BufferCreateParams()
    # sizes[6] no header — um array menor trunca tensores de 5 ou 6 dimensões.
    assert ctypes.sizeof(params.sizes) == 6 * ctypes.sizeof(ctypes.c_uint32)
    # vip_enum é vip_int32_t, não unsigned: um enum negativo viraria um valor
    # enorme e a chamada seria recusada com "argumento inválido".
    assert viplite.BufferCreateParams.data_format.size == 4


def test_union_de_quantizacao_compartilha_memoria():
    """
    `quant_data` é union no header. Se virasse struct, o offset de memory_type
    andaria e todo buffer seria criado com o tipo de memória errado.
    """
    import ctypes

    assert ctypes.sizeof(viplite._QuantData) == max(
        ctypes.sizeof(viplite._QuantDfp), ctypes.sizeof(viplite._QuantAffine)
    )


@pytest.mark.parametrize(
    "codigo,dtype",
    [(0, "float32"), (2, "uint8"), (3, "int8"), (5, "int16")],
)
def test_formatos_batem_com_vip_buffer_format_e(codigo, dtype):
    """Valores transcritos de vip_lite.h. Trocá-los reinterpreta os bytes."""
    import numpy as np

    assert np.dtype(viplite.FORMATOS[codigo]).name == dtype


# ── Quantização ────────────────────────────────────────────────────

def test_quantizacao_assimetrica_ida_e_volta():
    """
    O ACUITY quantiza a entrada. Alimentar float cru num tensor uint8 produz
    lixo sem erro nenhum — é o modo de falha mais caro deste caminho.
    """
    import numpy as np

    tensor = viplite.Tensor(0, 2, [1, 3, 4, 4], viplite.QUANT_TF_ASYMM, 0.00392157, 0, 0)
    original = np.array([0.0, 0.25, 0.5, 1.0], dtype=np.float32)

    voltou = tensor.desquantizar(tensor.quantizar(original))

    assert np.allclose(voltou, original, atol=0.01)
    assert tensor.quantizar(original).dtype == np.uint8


def test_quantizacao_satura_em_vez_de_dar_a_volta():
    """
    Sem clip, 300 vira 44 em uint8 por wraparound: um pixel saturado passaria a
    valer quase nada, e o efeito na detecção seria sutil e intermitente.
    """
    import numpy as np

    tensor = viplite.Tensor(0, 2, [4], viplite.QUANT_TF_ASYMM, 1.0, 0, 0)
    resultado = tensor.quantizar(np.array([-50.0, 300.0], dtype=np.float32))

    assert resultado[0] == 0
    assert resultado[1] == 255


def test_ponto_fixo_dinamico():
    import numpy as np

    tensor = viplite.Tensor(0, 5, [4], viplite.QUANT_DYNAMIC_FIXED_POINT, 1.0, 0, 8)
    voltou = tensor.desquantizar(tensor.quantizar(np.array([1.0, -2.5], dtype=np.float32)))

    assert np.allclose(voltou, [1.0, -2.5], atol=0.01)


def test_sem_quantizacao_preserva_float():
    import numpy as np

    tensor = viplite.Tensor(0, 0, [2], viplite.QUANT_NONE, 1.0, 0, 0)
    original = np.array([1.5, -0.25], dtype=np.float32)

    assert np.allclose(tensor.quantizar(original), original)


def test_contagem_de_elementos():
    tensor = viplite.Tensor(0, 2, [1, 3, 320, 320], viplite.QUANT_NONE, 1.0, 0, 0)
    assert tensor.elementos == 1 * 3 * 320 * 320


# ── Pipeline de compilação ─────────────────────────────────────────

def _script_compilacao():
    caminho = os.path.join(os.path.dirname(__file__), "..", "npu_compilation", "compilar_nbg.sh")
    with open(caminho, encoding="utf-8") as arquivo:
        return arquivo.read()


def test_empacotamento_e_viplite_nao_unify():
    """
    O exemplo do ai-sdk usa --pack-nbg-unify, para o driver unificado. Esta
    placa roda VIPLite: o grafo errado carrega e falha depois, no meio da
    inferência, com erro que não aponta o empacotamento.
    """
    script = _script_compilacao()
    assert "--pack-nbg-viplite" in script

    # Só linhas de comando: o comentário que explica a diferença precisa citar
    # os dois nomes.
    codigo = [l for l in script.splitlines() if not l.lstrip().startswith("#")]
    assert not any("--pack-nbg-unify" in linha for linha in codigo)


def test_quantizacao_padrao_e_por_canal():
    """
    As cabeças do YOLO têm faixas dinâmicas muito diferentes entre si. Escala
    única por tensor achata as menores até sumirem — queda de recall, não erro.
    """
    script = _script_compilacao()
    assert 'QUANT:-pcq' in script
    assert "perchannel_symmetric_affine" in script


def test_preprocessamento_da_calibracao_casa_com_a_engine():
    """
    A engine alimenta canvas_rgb/255.0. Se a calibração vir pixels 0-255, a
    quantização fica dimensionada para uma distribuição que nunca ocorre em
    produção — e nada nisso gera erro.
    """
    from edge import vivante_pose_engine as vpe

    script = _script_compilacao()
    # 1/255 = 0.00392157
    assert "0 0 0 0.00392157" in script
    assert "/ 255.0" in open(vpe.__file__, encoding="utf-8").read()


def test_extensao_do_grafo_aceita_a_que_o_acuity_gera():
    """
    O ACUITY nomeia a saída network_binary.nb. Aceitar só `.nbg` fazia o grafo
    cair no caminho de CPU sem aviso nenhum.
    """
    from edge import vivante_pose_engine as vpe

    assert ".nb" in vpe.EXTENSOES_NBG
    assert ".nbg" in vpe.EXTENSOES_NBG


def test_optimize_corresponde_a_geracao_do_silicio():
    """
    machinfo/a733/config.mk do ai-sdk: NPU_VERSION=v3, NPU_SW_VERSION=v2.0.

    São eixos distintos — v2.0 é o driver, v3 é o silício — e é o silício que
    escolhe o PID. Confundi-los levou este projeto ao PID do t527 (geração v2).
    Um PID de outra variante compila sem erro e produz um grafo que a NPU
    recusa ou executa errado.
    """
    script = _script_compilacao()
    assert "VIP9000NANODI_PLUS_PID0X1000003B" in script

    padrao = [l for l in script.splitlines() if l.startswith("OPTIMIZE=")]
    assert len(padrao) == 1
    assert "VIP9000NANODI_PLUS_PID0X1000003B" in padrao[0]


def test_vpm_run_recebe_arquivo_de_configuracao():
    """
    O vpm_run não aceita o .nb direto: lê um sample.txt com as seções
    [network]/[input]. Documentar errado faz o técnico concluir que o grafo
    está quebrado quando o problema é a invocação.
    """
    raiz = os.path.join(os.path.dirname(__file__), "..")
    for arquivo in ("npu_compilation/README.md", "DEPLOY.md",
                    "npu_compilation/compilar_nbg.sh", "deploy/instalar_npu_sdk.sh"):
        with open(os.path.join(raiz, arquivo), encoding="utf-8") as f:
            texto = f.read()
        if "vpm_run" not in texto:
            continue
        assert "[network]" in texto, f"{arquivo} não mostra o formato do sample.txt"

        import re
        # A forma errada: vpm_run recebendo o .nb diretamente.
        assert not re.search(r"vpm_run\s+\S*\.nb\b", texto), \
            f"{arquivo} invoca vpm_run com o .nb direto"
        # E a outra: sem o -s. O binário desta versão imprime a ajuda e sai,
        # o que parece falha do grafo mas é só a invocação.
        for invocacao in re.findall(r"vpm_run[^\n\"']*", texto):
            if "sample.txt" in invocacao:
                assert "-s" in invocacao, f"{arquivo}: falta -s em '{invocacao.strip()}'"


def test_pid_do_instalador_acompanha_o_do_compilador():
    """
    O instalador compara o chip ID reportado pela NPU com o PID que o
    compilador usa. Se os dois arquivos divergirem, o aviso dispara errado —
    ou pior, deixa passar uma divergência real.
    """
    import re

    raiz = os.path.join(os.path.dirname(__file__), "..")
    with open(os.path.join(raiz, "deploy", "instalar_npu_sdk.sh"), encoding="utf-8") as f:
        instalador = f.read()

    pid_instalador = re.search(r'PID_COMPILACAO="\$\{PID_COMPILACAO:-([^}]+)\}"', instalador)
    pid_compilador = re.search(r'^OPTIMIZE="\$\{OPTIMIZE:-([^}]+)\}"',
                               _script_compilacao(), re.MULTILINE)

    assert pid_instalador and pid_compilador
    assert pid_instalador.group(1) == pid_compilador.group(1)


def test_constantes_batem_com_o_que_o_hardware_reportou():
    """
    O teste de fumaça na placa reportou, para o NBG de referência:
        data_format=2, quant_format=2, scale=0.003922, zero_point=0

    Isso confirma no silício os valores transcritos de vip_lite.h. Se alguém
    renumerar as constantes, este teste cai antes de um grafo silenciosamente
    inválido chegar a campo.
    """
    import numpy as np

    assert viplite.FORMATOS[2] == "uint8"
    assert viplite.QUANT_TF_ASYMM == 2

    # scale=1/255 com zero_point=0: a faixa 0-255 do tensor representa 0.0-1.0,
    # que é exatamente o que a engine alimenta.
    tensor = viplite.Tensor(0, 2, [1, 3, 224, 224], viplite.QUANT_TF_ASYMM, 0.003922, 0, 0)
    assert tensor.dtype == np.dtype("uint8")
    assert tensor.quantizar(np.array([1.0], dtype=np.float32))[0] == 255
    assert tensor.quantizar(np.array([0.0], dtype=np.float32))[0] == 0
