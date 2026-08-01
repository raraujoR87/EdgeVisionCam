"""
Configuracao compartilhada dos testes.

O ponto central e isolar o banco: `core.database.db` resolve os caminhos do
SQLite no momento do import, entao os testes os reapontam para um diretorio
temporario antes de qualquer conexao ser aberta. Sem isso a suite escreveria
no system.db real do appliance.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """
    Cliente HTTP da API com bancos limpos e segredos proprios.

    Devolve o TestClient ja com o ciclo de startup executado, que e quem cria
    as tabelas e semeia os segredos de sessao.
    """
    from fastapi.testclient import TestClient

    import core.database.db as db_module

    monkeypatch.setattr(db_module, "SYSTEM_DB_PATH", str(tmp_path / "system.db"))
    monkeypatch.setattr(db_module, "QUEUE_DB_PATH", str(tmp_path / "queue.db"))

    import core.api_internal.main as api

    # O modulo da API guarda os segredos em variaveis globais preenchidas no
    # startup; zeramos para nao herdar valores de um teste anterior.
    monkeypatch.setattr(api, "SESSION_SECRET", "", raising=False)
    monkeypatch.setattr(api, "INTERNAL_SECRET", "", raising=False)
    monkeypatch.setattr(api, "latest_frame_bytes", None, raising=False)
    monkeypatch.setattr(api, "engine_ready", False, raising=False)

    with TestClient(api.app) as client:
        yield client


SENHA_DE_TESTE = "SenhaDeTeste2026"


@pytest.fixture()
def senha_configurada():
    """
    A senha definida por `auth_token`.

    Exposta como fixture, e nao importada do conftest: existe um pacote `tests`
    instalado no site-packages deste ambiente, e o import por nome resolvia para
    ele em vez de para este arquivo.
    """
    return SENHA_DE_TESTE


@pytest.fixture()
def token_senha_padrao(api_client):
    """
    Token emitido com a senha de fabrica ainda ativa.

    Autentica, mas o appliance so libera a troca de senha nesse estado — use
    `auth_token` para exercitar o restante da API.
    """
    resp = api_client.post("/api/auth/login", json={"password": "admin"})
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


@pytest.fixture()
def auth_token(api_client, token_senha_padrao):
    """
    Token de uma instalacao ja configurada.

    Troca a senha de fabrica primeiro, porque o sistema fica bloqueado enquanto
    ela estiver em uso — que e exatamente o estado de um appliance recem-ligado.
    """
    resp = api_client.post(
        "/api/auth/change-password",
        json={"old_password": "admin", "new_password": SENHA_DE_TESTE},
        headers={"Authorization": f"Bearer {token_senha_padrao}"},
    )
    assert resp.status_code == 200, resp.text

    resp = api_client.post("/api/auth/login", json={"password": SENHA_DE_TESTE})
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


@pytest.fixture()
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}
