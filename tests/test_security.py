"""
Testes das primitivas de autenticacao.

Cobrem especificamente as falhas encontradas na revisao do sistema:
token sem assinatura, hash de senha sem salt e ausencia de expiracao.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core.security import (  # noqa: E402
    hash_password,
    is_legacy_hash,
    issue_token,
    validate_token,
    verify_password,
)

SECRET = "segredo-de-teste-com-tamanho-suficiente"


# ── Senhas ─────────────────────────────────────────────────────────

def test_hash_password_verifica_senha_correta():
    stored = hash_password("SenhaForte2026")
    assert verify_password("SenhaForte2026", stored)


def test_hash_password_rejeita_senha_errada():
    stored = hash_password("SenhaForte2026")
    assert not verify_password("SenhaFraca", stored)


def test_hash_password_usa_salt_diferente_a_cada_chamada():
    """Dois hashes da mesma senha nao podem coincidir, senao um rainbow
    table quebra todas as instalacoes de uma vez."""
    assert hash_password("mesma") != hash_password("mesma")


def test_verify_password_aceita_hash_legado_sha256():
    """Instalacoes antigas gravaram sha256 puro e precisam continuar logando."""
    import hashlib

    legacy = hashlib.sha256(b"admin").hexdigest()
    assert is_legacy_hash(legacy)
    assert verify_password("admin", legacy)
    assert not verify_password("errada", legacy)


def test_hash_pbkdf2_nao_e_confundido_com_legado():
    assert not is_legacy_hash(hash_password("admin"))


@pytest.mark.parametrize("valor", ["", "lixo", "pbkdf2_sha256$abc$sal$hash", "a$b$c$d"])
def test_verify_password_rejeita_hash_malformado(valor):
    assert not verify_password("qualquer", valor)


# ── Tokens ─────────────────────────────────────────────────────────

def test_token_valido_com_segredo_correto():
    assert validate_token(SECRET, issue_token(SECRET))


def test_token_rejeitado_com_segredo_diferente():
    """Impede que uma instalacao aceite token emitido por outra."""
    assert not validate_token("outro-segredo-qualquer", issue_token(SECRET))


def test_token_adulterado_e_rejeitado():
    token = issue_token(SECRET)
    assert not validate_token(SECRET, token[:-4] + "zzzz")


def test_payload_adulterado_e_rejeitado():
    """O ataque real: reescrever o payload mantendo o formato do token."""
    import base64
    import json

    token = issue_token(SECRET)
    raw = token[len("visioncam_tok_"):]
    _, _, signature = raw.partition(".")

    forjado = base64.urlsafe_b64encode(
        json.dumps({"sub": "admin", "exp": int(time.time()) + 9999}).encode()
    ).decode().rstrip("=")

    assert not validate_token(SECRET, f"visioncam_tok_{forjado}.{signature}")


def test_token_expirado_e_rejeitado():
    assert not validate_token(SECRET, issue_token(SECRET, ttl=-1))


@pytest.mark.parametrize(
    "valor",
    ["", "lixo", "visioncam_tok_", "visioncam_tok_semponto", "mock_test_admin_token"],
)
def test_token_malformado_e_rejeitado(valor):
    """`mock_test_admin_token` era um backdoor aceito pela API antiga."""
    assert not validate_token(SECRET, valor)
