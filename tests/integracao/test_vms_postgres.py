"""
VMS Cloud — isolamento e privilégios contra um Postgres de verdade.

Cada execução cria um banco próprio, aplica vms-cloud/db/schema.sql e roda os
cenários com a conexão assumindo o papel `vms_app`, como a aplicação faz.
Banco próprio por execução: o esquema usa `public` e funções com search_path
fixo, então dividir o banco com outro módulo causaria colisão de nomes.

Pulado quando DATABASE_URL_TESTE não está definida.
"""

import os
import pathlib
import secrets
import urllib.parse

import pytest

psycopg2 = pytest.importorskip("psycopg2", reason="psycopg2 não instalado")
from psycopg2 import errors  # noqa: E402

URL = os.environ.get("DATABASE_URL_TESTE")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL_TESTE não definida")

RAIZ = pathlib.Path(__file__).resolve().parents[2]
SCHEMA = RAIZ / "vms-cloud" / "db" / "schema.sql"


def _url_com_banco(url: str, nome: str) -> str:
    partes = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(partes._replace(path=f"/{nome}"))


@pytest.fixture(scope="module")
def banco():
    nome = f"vms_teste_{secrets.token_hex(4)}"
    admin = psycopg2.connect(URL)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{nome}"')
    admin.close()

    conn = psycopg2.connect(_url_com_banco(URL, nome))
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(SCHEMA.read_text(encoding="utf-8"))
        cur.execute(SEED)
    conn.close()

    yield _url_com_banco(URL, nome)

    admin = psycopg2.connect(URL)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (nome,))
        cur.execute(f'DROP DATABASE IF EXISTS "{nome}"')
    admin.close()


# Dois clientes e um fornecedor. Os ids são fixados pelo seed para que os
# testes possam referenciar cada papel sem consultar.
SEED = """
INSERT INTO organizations (id, name, slug, plan) VALUES
  (1, 'ACME Varejo', 'acme', 'essencial'),
  (2, 'Beta Mercado', 'beta', 'trial');

INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES
  (1, 'admin@acme.test',      'h', false),
  (2, 'operador@acme.test',   'h', false),
  (3, 'visualizador@acme.test','h', false),
  (4, 'admin@beta.test',      'h', false),
  (5, 'fornecedor@vms.test',  'h', true),
  (6, 'sem-vinculo@test',     'h', false);

INSERT INTO memberships (user_id, organization_id, role) VALUES
  (1, 1, 'ADMIN'), (2, 1, 'OPERADOR'), (3, 1, 'VISUALIZADOR'), (4, 2, 'ADMIN');

INSERT INTO sites (id, organization_id, name) VALUES (1, 1, 'Loja ACME Centro'), (2, 2, 'Loja Beta');
INSERT INTO cameras (id, organization_id, site_id, external_ref, name) VALUES
  (1, 1, 1, 'cam-1', 'Corredor'), (2, 2, 2, 'cam-b', 'Caixa');
INSERT INTO agents (id, organization_id, site_id, name, key_hash, key_prefix) VALUES
  (1, 1, 1, 'Agente ACME', 'hash-acme', 'vms_ag_aaaa'),
  (2, 2, 2, 'Agente Beta', 'hash-beta', 'vms_ag_bbbb');

INSERT INTO events (id, organization_id, site_id, camera_id, agent_id, occurred_at,
                    status, verdict, confidence, summary) VALUES
  (1, 1, 1, 1, 1, now() - interval '1 hour', 'ANALISADO', 'SUSPEITO',    0.90, 'Mão ao bolso'),
  (2, 1, 1, 1, 1, now() - interval '2 hours','ANALISADO', 'SEM_INDICIO', 0.10, 'Passagem normal'),
  (3, 2, 2, 2, 2, now() - interval '1 hour', 'ANALISADO', 'SUSPEITO',    0.85, 'Evento da Beta');
"""


@pytest.fixture
def conn(banco):
    c = psycopg2.connect(banco)
    c.autocommit = False
    yield c
    c.rollback()
    c.close()


def como(conn, user_id):
    """Assume o papel da aplicação e declara a identidade, como lib/tenant.ts."""
    cur = conn.cursor()
    cur.execute("SET LOCAL ROLE vms_app")
    cur.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
    return cur


def _falha(conn, sql, params=()):
    """Executa dentro de SAVEPOINT e devolve o código de erro, sem abortar a transação."""
    cur = conn.cursor()
    cur.execute("SAVEPOINT tentativa")
    try:
        cur.execute(sql, params)
        cur.execute("RELEASE SAVEPOINT tentativa")
        return None
    except psycopg2.Error as e:
        cur.execute("ROLLBACK TO SAVEPOINT tentativa")
        return e.pgcode


# ── Pedra angular ────────────────────────────────────────────────────


def test_papel_da_aplicacao_nao_ignora_rls(conn):
    """Se o papel ignorasse RLS, toda política seria decorativa."""
    cur = conn.cursor()
    cur.execute("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'vms_app'")
    assert cur.fetchone()[0] is False


def test_sem_identidade_declarada_nao_ve_nada(conn):
    cur = conn.cursor()
    cur.execute("SET LOCAL ROLE vms_app")
    for tabela in ("organizations", "events", "sites", "audit_log", "memberships"):
        cur.execute(f"SELECT COUNT(*) FROM {tabela}")
        assert cur.fetchone()[0] == 0, f"{tabela} visível sem identidade"


# ── Isolamento entre clientes ────────────────────────────────────────


def test_admin_ve_so_os_eventos_do_seu_cliente(conn):
    cur = como(conn, 1)
    cur.execute("SELECT id FROM events ORDER BY id")
    assert [r[0] for r in cur.fetchall()] == [1, 2]


def test_id_de_outro_cliente_na_consulta_devolve_vazio(conn):
    """O ataque mais barato: trocar o id na URL pelo do concorrente."""
    cur = como(conn, 1)
    cur.execute("SELECT COUNT(*) FROM events WHERE id = 3")
    assert cur.fetchone()[0] == 0


def test_organizacoes_visiveis_se_limitam_as_do_usuario(conn):
    cur = como(conn, 1)
    cur.execute("SELECT slug FROM organizations ORDER BY slug")
    assert [r[0] for r in cur.fetchall()] == ["acme"]


def test_usuarios_visiveis_sao_so_os_que_dividem_organizacao(conn):
    """O usuário de outro cliente não aparece na equipe, nem o e-mail dele."""
    cur = como(conn, 1)
    cur.execute("SELECT email FROM users ORDER BY email")
    emails = [r[0] for r in cur.fetchall()]
    assert "admin@beta.test" not in emails
    assert "admin@acme.test" in emails


def test_usuario_sem_vinculo_nao_ve_clientes(conn):
    cur = como(conn, 6)
    cur.execute("SELECT COUNT(*) FROM organizations")
    assert cur.fetchone()[0] == 0
    cur.execute("SELECT COUNT(*) FROM events")
    assert cur.fetchone()[0] == 0


def test_fornecedor_ve_todos_os_clientes(conn):
    cur = como(conn, 5)
    cur.execute("SELECT COUNT(*) FROM organizations")
    assert cur.fetchone()[0] == 2
    cur.execute("SELECT COUNT(*) FROM events")
    assert cur.fetchone()[0] == 3


def test_identidade_nao_e_vazada_entre_transacoes_do_pool(conn):
    """
    SET LOCAL morre no COMMIT. Uma conexão reaproveitada pelo pool não pode
    herdar a identidade da requisição anterior.
    """
    como(conn, 1)
    conn.commit()
    cur = conn.cursor()
    cur.execute("SELECT current_setting('app.user_id', true)")
    assert cur.fetchone()[0] in (None, "")


# ── Papéis dentro do cliente ─────────────────────────────────────────


def test_visualizador_le_mas_nao_revisa(conn):
    cur = como(conn, 3)
    cur.execute("SELECT COUNT(*) FROM events")
    assert cur.fetchone()[0] == 2
    cur.execute("UPDATE events SET human_verdict = 'PROCEDE', reviewed_by = 3 WHERE id = 1")
    assert cur.rowcount == 0, "visualizador conseguiu revisar um evento"


def test_operador_revisa_evento_do_seu_cliente(conn):
    cur = como(conn, 2)
    cur.execute(
        "UPDATE events SET human_verdict = 'PROCEDE', reviewed_by = 2, reviewed_at = now() WHERE id = 1"
    )
    assert cur.rowcount == 1


def test_revisao_nao_pode_ser_atribuida_a_outra_pessoa(conn):
    """A revisão registra quem fez. Atribuir a outro usuário seria falsificar a trilha."""
    como(conn, 2)
    codigo = _falha(conn, "UPDATE events SET human_verdict = 'PROCEDE', reviewed_by = 1 WHERE id = 1")
    assert codigo == "42501"


def test_operador_nao_consegue_alterar_o_veredito_da_ia(conn):
    """
    O veredito é o que a IA produziu. Nenhum papel de usuário o altera — o
    privilégio é só de colunas de revisão.
    """
    como(conn, 2)
    codigo = _falha(conn, "UPDATE events SET verdict = 'SEM_INDICIO' WHERE id = 1")
    assert codigo == "42501"


def test_operador_nao_revisa_evento_de_outro_cliente(conn):
    cur = como(conn, 2)
    cur.execute("UPDATE events SET human_verdict = 'FALSO_ALARME', reviewed_by = 2 WHERE id = 3")
    assert cur.rowcount == 0


def test_operador_nao_insere_evento(conn):
    """Eventos entram só pelo caminho do agente, nunca por um usuário."""
    como(conn, 2)
    codigo = _falha(
        conn,
        "INSERT INTO events (organization_id, site_id, occurred_at) VALUES (1, 1, now())",
    )
    assert codigo == "42501"


# ── Governança: equipe, locais, trilha ───────────────────────────────


def test_visualizador_nao_altera_equipe(conn):
    como(conn, 3)
    codigo = _falha(conn, "INSERT INTO memberships (user_id, organization_id, role) VALUES (6, 1, 'ADMIN')")
    assert codigo == "42501"


def test_admin_nao_cria_vinculo_em_cliente_alheio(conn):
    como(conn, 1)
    codigo = _falha(conn, "INSERT INTO memberships (user_id, organization_id, role) VALUES (6, 2, 'ADMIN')")
    assert codigo == "42501"


def test_admin_cria_convite_so_no_seu_cliente(conn):
    cur = como(conn, 1)
    cur.execute(
        "INSERT INTO invites (organization_id, email, role, token_hash, expires_at) "
        "VALUES (1, 'novo@acme.test', 'OPERADOR', 'h1', now() + interval '72 hours')"
    )
    assert cur.rowcount == 1
    codigo = _falha(
        conn,
        "INSERT INTO invites (organization_id, email, role, token_hash, expires_at) "
        "VALUES (2, 'x@beta.test', 'ADMIN', 'h2', now() + interval '72 hours')",
    )
    assert codigo == "42501"


def test_trilha_nao_pode_ser_alterada_nem_apagada(conn):
    """Trilha que a aplicação consegue editar não serve como trilha."""
    como(conn, 1)
    assert _falha(conn, "UPDATE audit_log SET action = 'nada'") == "42501"
    assert _falha(conn, "DELETE FROM audit_log") == "42501"


def test_entrada_de_auditoria_so_em_nome_proprio(conn):
    """Um usuário não grava registro em nome de outro, nem em cliente alheio."""
    como(conn, 1)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO audit_log (organization_id, actor_user_id, action) VALUES (1, 1, 'teste')"
    )
    assert _falha(conn, "INSERT INTO audit_log (organization_id, actor_user_id, action) VALUES (1, 2, 'falso')") == "42501"
    assert _falha(conn, "INSERT INTO audit_log (organization_id, actor_user_id, action) VALUES (2, 1, 'falso')") == "42501"


def test_trilha_visivel_so_para_administrador(conn):
    como(conn, 2)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM audit_log")
    assert cur.fetchone()[0] == 0, "operador leu a trilha"


def test_administrador_nao_apaga_outro_cliente_nem_altera_plano(conn):
    cur = como(conn, 1)
    cur.execute("UPDATE organizations SET plan = 'enterprise' WHERE id = 2")
    assert cur.rowcount == 0, "admin de um cliente alterou outro cliente"


def test_fornecedor_altera_plano(conn):
    cur = como(conn, 5)
    cur.execute("UPDATE organizations SET plan = 'profissional' WHERE id = 2 RETURNING plan")
    assert cur.fetchone()[0] == "profissional"


# ── Invariantes de produto ───────────────────────────────────────────


def test_nenhuma_coluna_guarda_imagem(conn):
    """
    Produto sem armazenamento de vídeo: nenhuma coluna pode receber imagem.
    Se alguém criar uma, este teste falha antes do deploy.
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT table_name, column_name, data_type
          FROM information_schema.columns
         WHERE table_schema = 'public'
    """)
    suspeitas = [
        (t, c, d) for t, c, d in cur.fetchall()
        if d == "bytea" or any(p in c.lower() for p in ("frame", "video", "jpeg", "imagem", "image", "clip"))
    ]
    assert suspeitas == [], f"coluna pode guardar imagem: {suspeitas}"


def test_evento_guarda_veredito_e_nao_o_frame(conn):
    cur = conn.cursor()
    cur.execute("""
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events'
    """)
    colunas = {r[0] for r in cur.fetchall()}
    assert {"verdict", "confidence", "summary", "human_verdict"} <= colunas
    assert not any("frame" in c or "video" in c for c in colunas)
