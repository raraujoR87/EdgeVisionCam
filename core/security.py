"""
Primitivas de autenticacao do VisionCam.

Centraliza hashing de senha, emissao/validacao de tokens de sessao e o segredo
compartilhado usado pela engine para falar com os endpoints internos da API.

Decisoes de projeto:

- Tokens sao assinados com HMAC-SHA256 e carregam validade. Sao stateless, o
  que significa que uma sessao aberta sobrevive a um restart da API — o modelo
  anterior guardava tokens num set em memoria e derrubava todos os operadores
  a cada reinicio do container.
- Senhas usam PBKDF2-HMAC-SHA256 com salt por senha. Hashes SHA-256 puros
  gravados por versoes antigas continuam sendo aceitos e sao convertidos para
  PBKDF2 de forma transparente no primeiro login bem-sucedido.
- Os segredos vivem na tabela `config` do system.db e sao gerados na primeira
  execucao, entao nenhuma instalacao compartilha chave com outra.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

# Custo do PBKDF2. Alto o suficiente para tornar forca bruta offline cara,
# baixo o suficiente para nao pesar no login de um SBC de borda.
PBKDF2_ITERATIONS = 260_000
PBKDF2_PREFIX = "pbkdf2_sha256"

TOKEN_PREFIX = "visioncam_tok_"
DEFAULT_TOKEN_TTL = 12 * 60 * 60  # 12h — cobre um turno de operacao

SESSION_SECRET_KEY = "session_secret"
INTERNAL_SECRET_KEY = "internal_secret"


# ──────────────────────────────────────────────────────────────────
# Senhas
# ──────────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    """Gera um hash PBKDF2 com salt novo, no formato prefixo$iters$salt$hash."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    ).hex()
    return f"{PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${salt}${digest}"


def is_legacy_hash(stored: str) -> bool:
    """True para os hashes SHA-256 sem salt gravados por versoes antigas."""
    return len(stored) == 64 and not stored.startswith(PBKDF2_PREFIX)


def verify_password(password: str, stored: str) -> bool:
    """
    Confere a senha contra o hash gravado, aceitando tanto PBKDF2 quanto o
    formato legado. Sempre usa comparacao em tempo constante.
    """
    if not stored:
        return False

    if is_legacy_hash(stored):
        legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(legacy, stored)

    try:
        prefix, iterations, salt, expected = stored.split("$", 3)
    except ValueError:
        return False
    if prefix != PBKDF2_PREFIX:
        return False

    try:
        iters = int(iterations)
    except ValueError:
        return False

    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), iters
    ).hex()
    return hmac.compare_digest(digest, expected)


# ──────────────────────────────────────────────────────────────────
# Tokens de sessao
# ──────────────────────────────────────────────────────────────────

def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_token(secret: str, subject: str = "admin", ttl: int = DEFAULT_TOKEN_TTL) -> str:
    """Emite um token assinado com validade de `ttl` segundos."""
    now = int(time.time())
    payload = {"sub": subject, "iat": now, "exp": now + ttl, "jti": secrets.token_hex(8)}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _b64e(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{TOKEN_PREFIX}{body}.{signature}"


def validate_token(secret: str, token: str) -> bool:
    """
    True somente se a assinatura confere e o token ainda nao expirou.
    Nao levanta excecao — qualquer entrada malformada e simplesmente invalida.
    """
    if not token or not token.startswith(TOKEN_PREFIX):
        return False

    raw = token[len(TOKEN_PREFIX):]
    if "." not in raw:
        return False

    body, _, signature = raw.partition(".")
    expected = _b64e(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(signature, expected):
        return False

    try:
        payload = json.loads(_b64d(body))
    except Exception:
        return False

    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time()):
        return False

    return True


# ──────────────────────────────────────────────────────────────────
# Segredos persistidos
# ──────────────────────────────────────────────────────────────────

async def get_or_create_secret(db, key: str) -> str:
    """
    Le um segredo da tabela `config`, gerando e gravando um novo na primeira
    execucao. Recebe uma conexao aberta para nao ditar o ciclo de vida do banco.
    """
    async with db.execute("SELECT value FROM config WHERE key = ?", (key,)) as cursor:
        row = await cursor.fetchone()
    if row and row["value"]:
        return row["value"]

    generated = secrets.token_urlsafe(48)
    await db.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, generated)
    )
    await db.commit()
    return generated


def get_internal_secret_sync(db_path: str) -> str:
    """
    Versao sincrona usada pela engine, que precisa do segredo interno antes de
    ter um event loop rodando. Somente leitura: a API e quem semeia o valor no
    startup, entao um retorno vazio apenas significa que a API ainda nao subiu.
    """
    import sqlite3

    env_override = os.getenv("VISIONCAM_INTERNAL_SECRET")
    if env_override:
        return env_override

    if not os.path.exists(db_path):
        return ""
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.execute(
            "SELECT value FROM config WHERE key = ?", (INTERNAL_SECRET_KEY,)
        )
        row = cur.fetchone()
        conn.close()
        return row[0] if row else ""
    except Exception:
        return ""
