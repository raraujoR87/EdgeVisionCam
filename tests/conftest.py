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


@pytest.fixture()
def auth_token(api_client):
    """Token de sessao valido, obtido com a senha padrao de fabrica."""
    resp = api_client.post("/api/auth/login", json={"password": "admin"})
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


@pytest.fixture()
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}
