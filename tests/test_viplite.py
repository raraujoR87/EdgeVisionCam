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
    assert viplite.MODULO_KERNEL == "sunxi_npu"


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
    assert "sunxi_npu" in motivo


def test_modulo_presente_mas_descarregado_sugere_modprobe(monkeypatch):
    """
    É a diferença entre 'trocar a imagem do sistema' e 'rodar um comando'."""
    monkeypatch.setattr(viplite.os.path, "exists", lambda caminho: False)
    monkeypatch.setattr(viplite, "modulo_existe", lambda: True)
    monkeypatch.setattr(viplite, "modulo_carregado", lambda: False)

    disponivel, motivo = viplite.disponivel()

    assert not disponivel
    assert "modprobe sunxi_npu" in motivo


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


def test_grafo_nao_finge_estar_implementado(monkeypatch):
    """
    Enquanto o binding não existe, ele precisa dizer isso. Um stub que devolve
    tensores vazios seria indistinguível de "nenhuma pessoa detectada" — num
    sistema antifurto, o pior modo de falha possível.
    """
    monkeypatch.setattr(viplite, "disponivel", lambda: (True, "ok"))

    with pytest.raises(viplite.NpuIndisponivel, match="nao implementado"):
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
