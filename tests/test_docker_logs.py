"""
Testes do endpoint de logs de container e do cliente Docker.

O nome do container vinha da URL direto para a requisicao ao daemon, sem
validacao. Estes testes travam a lista de containers permitidos e o
desenquadramento do fluxo de log.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core import docker_client  # noqa: E402


# ── Endpoint de logs ───────────────────────────────────────────────

def test_logs_exigem_token(api_client):
    assert api_client.get("/api/logs/visioncam-core").status_code == 401


def test_logs_recusam_container_desconhecido(api_client, auth_headers):
    """
    A lista impede que o console leia os logs de containers de terceiros que
    por acaso rodem no mesmo host.
    """
    resp = api_client.get("/api/logs/outro-container-qualquer", headers=auth_headers)
    assert resp.status_code == 400
    assert "não reconhecido" in resp.json()["detail"]


@pytest.mark.parametrize(
    "nome",
    [
        "..%2F..%2Fcontainers%2Fjson",  # barra codificada
        "visioncam-core/json",          # segmento extra
    ],
)
def test_logs_bloqueiam_travessia_de_rota(api_client, auth_headers, nome):
    """
    Tentativas de escapar da rota /logs para outros endpoints da API do Docker.

    Quem barra aqui e o roteamento: `{container_name}` casa um unico segmento,
    entao a requisicao nem chega ao handler (404). A lista de containers e a
    segunda camada, para nomes que sao um segmento valido.
    """
    assert api_client.get(f"/api/logs/{nome}", headers=auth_headers).status_code == 404


def test_query_extra_nao_altera_o_container_consultado(api_client, auth_headers):
    """
    Parametros de query nao contaminam a chamada ao Docker: a URI enviada ao
    daemon e montada pelo cliente, nao copiada da requisicao original.
    """
    resp = api_client.get("/api/logs/visioncam-core?follow=true", headers=auth_headers)
    assert resp.status_code == 200


def test_lista_de_containers_cobre_o_seletor_da_ui():
    """
    As opcoes do seletor em ui/app/settings/page.tsx precisam existir na lista,
    senao o console pede um log que a API sempre recusa.
    """
    import core.api_internal.main as api

    do_seletor = {"visioncam-core", "visioncam-ui-local", "visioncam-frigate"}
    assert do_seletor <= api.CONTAINERS_VISIVEIS


# ── Cliente Docker ─────────────────────────────────────────────────

def test_modo_padrao_e_socket(monkeypatch):
    monkeypatch.setattr(docker_client, "PROXY_HOST", "")
    assert docker_client.modo() == "socket"


def test_modo_proxy_quando_host_definido(monkeypatch):
    monkeypatch.setattr(docker_client, "PROXY_HOST", "docker-socket-proxy")
    assert docker_client.modo() == "proxy"


def test_socket_ausente_gera_erro_tratavel(monkeypatch, tmp_path):
    """Docker inacessivel nao pode derrubar a API — vira erro tratavel."""
    monkeypatch.setattr(docker_client, "PROXY_HOST", "")
    monkeypatch.setattr(docker_client, "SOCKET_PATH", str(tmp_path / "inexistente.sock"))

    with pytest.raises(docker_client.DockerIndisponivel):
        docker_client.requisitar("GET", "/containers/json")


def test_reiniciar_container_devolve_false_sem_docker(monkeypatch, tmp_path):
    monkeypatch.setattr(docker_client, "PROXY_HOST", "")
    monkeypatch.setattr(docker_client, "SOCKET_PATH", str(tmp_path / "inexistente.sock"))
    assert docker_client.reiniciar_container("visioncam-frigate") is False


# ── Desenquadramento do fluxo de log ───────────────────────────────

def test_desenquadra_fluxo_sem_tty():
    """Cada trecho vem com 8 bytes de cabecalho que nao podem vazar para a UI."""
    quadro = b"\x01\x00\x00\x00\x00\x00\x00\x05hello"
    assert docker_client._desenquadrar(quadro) == "hello"


def test_desenquadra_multiplos_quadros():
    quadros = (
        b"\x01\x00\x00\x00\x00\x00\x00\x03abc"
        b"\x02\x00\x00\x00\x00\x00\x00\x03def"  # stderr
    )
    assert docker_client._desenquadrar(quadros) == "abcdef"


def test_fluxo_com_tty_passa_direto():
    """Container com TTY emite texto cru, sem cabecalho."""
    assert docker_client._desenquadrar(b"linha solta") == "linha solta"


def test_corpo_vazio_nao_quebra():
    assert docker_client._desenquadrar(b"") == ""
