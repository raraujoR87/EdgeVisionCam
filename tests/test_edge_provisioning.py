"""
Testes do resgate de provisionamento no appliance.

O código é digitado por um técnico numa loja. Erro aqui não é um teste vermelho:
é uma visita perdida, com o cliente esperando.
"""

import json
import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import edge_provisioning as prov  # noqa: E402


# ── Normalização e validação ───────────────────────────────────────

@pytest.mark.parametrize(
    "entrada",
    ["ABCD-EFGH", "abcd-efgh", "ABCDEFGH", " abcd efgh ", "AbCd-EfGh"],
)
def test_normalizacao_aceita_variacoes_de_digitacao(entrada):
    assert prov.normalizar_codigo(entrada) == "ABCD-EFGH"


@pytest.mark.parametrize("entrada", ["", "ABC", "ABCDEFGHI", None])
def test_normalizacao_rejeita_tamanho_errado(entrada):
    assert prov.normalizar_codigo(entrada) == ""


def test_alfabeto_igual_ao_da_nuvem():
    """
    Divergir do gerador em ui/app/api/provisioning/codigo.ts faria a placa
    recusar códigos legítimos — falha que só apareceria na loja.
    """
    caminho = os.path.join(
        os.path.dirname(__file__), "..", "ui", "app", "api", "provisioning", "codigo.ts"
    )
    with open(caminho, encoding="utf-8") as arquivo:
        conteudo = arquivo.read()
    assert f"'{prov.ALFABETO}'" in conteudo


@pytest.mark.parametrize("entrada", ["ABCD-EFG0", "ABCD-EFGO", "1234-5678"])
def test_codigo_com_caractere_ambiguo_e_invalido(entrada):
    assert not prov.codigo_valido(entrada)


def test_resgate_recusa_codigo_invalido_sem_ir_a_rede(monkeypatch):
    """Validar localmente evita uma ida à rede que já se sabe que vai falhar."""
    def nao_deve_ser_chamado(*args, **kwargs):
        raise AssertionError("não deveria abrir conexão")

    monkeypatch.setattr(prov.urllib.request, "urlopen", nao_deve_ser_chamado)

    with pytest.raises(prov.ErroDeProvisionamento, match="Código inválido"):
        prov.resgatar("codigo-ruim")


# ── Erros de rede ──────────────────────────────────────────────────

def test_erro_de_rede_e_traduzido_para_acao(monkeypatch):
    def falha(*args, **kwargs):
        raise urllib.error.URLError("Name or service not known")

    monkeypatch.setattr(prov.urllib.request, "urlopen", falha)

    with pytest.raises(prov.ErroDeProvisionamento, match="cabo de rede"):
        prov.resgatar("ACDE-FGHJ")


def test_codigo_recusado_pela_nuvem(monkeypatch):
    class RespostaDeErro(urllib.error.HTTPError):
        def __init__(self):
            super().__init__("url", 400, "Bad Request", {}, None)

        def read(self):
            return json.dumps({"error": "Codigo invalido ou expirado."}).encode()

    monkeypatch.setattr(
        prov.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(RespostaDeErro())
    )

    with pytest.raises(prov.ErroDeProvisionamento, match="expirado"):
        prov.resgatar("ACDE-FGHJ")


# ── Gravação do .env ───────────────────────────────────────────────

CONFIG = {
    "status": "success",
    "store": {"id": 3, "name": "Loja Piloto", "api_key": "vc_chave"},
    "deploy": {"version": "v1.2.0", "edge_key": "ek", "mgmt_mode": "portainer-edge-agent"},
}


def test_env_recebe_versao_e_chave(tmp_path):
    destino = tmp_path / ".env"
    gravadas = prov.gravar_env(CONFIG, "https://nuvem.exemplo", str(destino))

    conteudo = destino.read_text(encoding="utf-8")
    assert "VISIONCAM_TAG=v1.2.0" in conteudo
    assert "STORE_API_KEY=vc_chave" in conteudo
    assert "CLOUD_API_URL=https://nuvem.exemplo" in conteudo
    assert gravadas["VISIONCAM_TAG"] == "v1.2.0"


def test_env_preserva_ajustes_locais(tmp_path):
    """
    TZ e o caminho do modelo NPU são ajustados na placa. Uma reinstalação não
    pode apagá-los, ou a NPU volta silenciosamente para CPU.
    """
    destino = tmp_path / ".env"
    destino.write_text(
        "TZ=America/Manaus\nPOSE_MODEL_PATH=edge/yolov8n-pose.nbg\nVISIONCAM_TAG=v0.9.0\n",
        encoding="utf-8",
    )

    prov.gravar_env(CONFIG, "https://nuvem.exemplo", str(destino))

    conteudo = destino.read_text(encoding="utf-8")
    assert "TZ=America/Manaus" in conteudo
    assert "POSE_MODEL_PATH=edge/yolov8n-pose.nbg" in conteudo
    # A versão é gerenciada pelo provisionamento e deve ser substituída.
    assert "VISIONCAM_TAG=v1.2.0" in conteudo
    assert "VISIONCAM_TAG=v0.9.0" not in conteudo


def test_env_sem_versao_cai_em_latest(tmp_path):
    destino = tmp_path / ".env"
    config = {"store": {"api_key": "k"}, "deploy": {}}
    assert prov.gravar_env(config, None, str(destino))["VISIONCAM_TAG"] == "latest"
