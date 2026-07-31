"""
Testes de autenticacao e autorizacao da API do appliance.

Cada teste aqui corresponde a um vetor que estava aberto antes da revisao:
backdoor fixo, endpoints internos sem protecao, stream publico, travessia de
diretorio no servidor de midia e vazamento de segredos pelo /api/config.
"""

import pytest

# Todo endpoint que exige sessao valida. Manter a lista completa garante que
# um endpoint novo sem verify_token apareca como falha.
ENDPOINTS_PROTEGIDOS = [
    ("get", "/api/cameras"),
    ("get", "/api/zones"),
    ("get", "/api/config"),
    ("get", "/api/events"),
    ("get", "/api/telemetry"),
    ("get", "/api/auth/verify"),
]


# ── Login ──────────────────────────────────────────────────────────

def test_login_com_senha_padrao(api_client):
    resp = api_client.post("/api/auth/login", json={"password": "admin"})
    assert resp.status_code == 200
    assert resp.json()["token"].startswith("visioncam_tok_")


def test_login_com_senha_errada(api_client):
    resp = api_client.post("/api/auth/login", json={"password": "errada"})
    assert resp.status_code == 401


# ── Autorizacao ────────────────────────────────────────────────────

@pytest.mark.parametrize("metodo,rota", ENDPOINTS_PROTEGIDOS)
def test_endpoint_exige_token(api_client, metodo, rota):
    assert getattr(api_client, metodo)(rota).status_code == 401


@pytest.mark.parametrize("metodo,rota", ENDPOINTS_PROTEGIDOS)
def test_endpoint_aceita_token_valido(api_client, auth_headers, metodo, rota):
    assert getattr(api_client, metodo)(rota, headers=auth_headers).status_code == 200


def test_backdoor_mock_token_nao_e_aceito(api_client):
    """
    A API antiga liberava tudo para quem enviasse este token literal.
    Qualquer pessoa na rede tinha controle total do appliance.
    """
    resp = api_client.get(
        "/api/cameras", headers={"Authorization": "Bearer mock_test_admin_token"}
    )
    assert resp.status_code == 401


def test_token_de_outra_instalacao_nao_e_aceito(api_client):
    from core.security import issue_token

    forjado = issue_token("segredo-de-outra-instalacao")
    resp = api_client.get("/api/cameras", headers={"Authorization": f"Bearer {forjado}"})
    assert resp.status_code == 401


# ── Endpoints internos ─────────────────────────────────────────────

def test_frame_interno_exige_segredo(api_client):
    """Sem isso, qualquer um injeta imagem falsa no monitor do SOC."""
    assert api_client.post("/api/internal/frame", content=b"falso").status_code == 401


def test_engine_ready_exige_segredo(api_client):
    assert api_client.post("/api/internal/engine-ready", content=b"ok").status_code == 401


def test_frame_interno_aceita_segredo_correto(api_client):
    import core.api_internal.main as api

    resp = api_client.post(
        "/api/internal/frame",
        content=b"jpeg-bytes",
        headers={"X-Internal-Token": api.INTERNAL_SECRET},
    )
    assert resp.status_code == 200


def test_token_de_sessao_nao_serve_para_endpoint_interno(api_client, auth_token):
    """Os dois planos de autenticacao sao independentes de proposito."""
    resp = api_client.post(
        "/api/internal/frame", content=b"x", headers={"X-Internal-Token": auth_token}
    )
    assert resp.status_code == 401


# ── Midia e stream ─────────────────────────────────────────────────

def test_media_exige_token(api_client):
    assert api_client.get("/media/qualquer.mp4").status_code == 401


def test_media_bloqueia_travessia_de_diretorio(api_client, auth_headers):
    resp = api_client.get("/media/..%2F..%2F..%2Fetc%2Fpasswd", headers=auth_headers)
    assert resp.status_code in (400, 404)
    assert b"root:" not in resp.content


def test_video_feed_exige_token(api_client):
    assert api_client.get("/video_feed").status_code == 401


# ── Vazamento de configuracao ──────────────────────────────────────

def test_config_nao_expoe_segredos(api_client, auth_headers):
    """
    /api/config devolvia a tabela inteira. Com os segredos de sessao agora
    guardados ali, isso entregaria a chave que assina os tokens.
    """
    dados = api_client.get("/api/config", headers=auth_headers).json()

    for chave in (
        "session_secret",
        "internal_secret",
        "admin_password_hash",
        "gemini_api_key",
        "telegram_bot_token",
        "store_api_key",
    ):
        assert chave not in dados, f"{chave} vazou pela API"

    # O indicador de presenca continua disponivel para a UI.
    assert dados["session_secret_is_set"] is True


# ── Troca de senha ─────────────────────────────────────────────────

def test_troca_de_senha_e_login_subsequente(api_client, auth_headers):
    resp = api_client.post(
        "/api/auth/change-password",
        json={"old_password": "admin", "new_password": "NovaSenha2026"},
        headers=auth_headers,
    )
    assert resp.status_code == 200

    assert api_client.post("/api/auth/login", json={"password": "NovaSenha2026"}).status_code == 200
    assert api_client.post("/api/auth/login", json={"password": "admin"}).status_code == 401


def test_troca_de_senha_rejeita_senha_curta(api_client, auth_headers):
    resp = api_client.post(
        "/api/auth/change-password",
        json={"old_password": "admin", "new_password": "curta"},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_troca_de_senha_exige_senha_antiga(api_client, auth_headers):
    resp = api_client.post(
        "/api/auth/change-password",
        json={"old_password": "chute", "new_password": "NovaSenha2026"},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_flag_de_senha_padrao_baixa_apos_troca(api_client, auth_headers):
    assert api_client.get("/api/config", headers=auth_headers).json()["password_is_default"] == "true"

    api_client.post(
        "/api/auth/change-password",
        json={"old_password": "admin", "new_password": "NovaSenha2026"},
        headers=auth_headers,
    )
    assert api_client.get("/api/config", headers=auth_headers).json()["password_is_default"] == "false"
