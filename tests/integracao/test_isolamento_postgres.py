"""
Isolamento entre inquilinos, contra um Postgres de verdade.

Os outros testes leem código-fonte. Este executa SQL: cria dois clientes,
assume a identidade de um e verifica que o outro é invisível.

Roda no CI com um Postgres em container. Sem ele, "os clientes estão isolados"
é uma afirmação que alguém verificou uma vez à mão — e que regride em silêncio
na primeira política mexida.

Pulado quando DATABASE_URL_TESTE não está definida, para não quebrar o
desenvolvimento local de quem não subiu banco.
"""

import os
import pathlib

import pytest

psycopg = pytest.importorskip("psycopg2", reason="psycopg2 não instalado")

URL = os.environ.get("DATABASE_URL_TESTE")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL_TESTE não definida")

RAIZ = pathlib.Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def conexao():
    conn = psycopg.connect(URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        # Schema base + migração multi-tenant, na ordem em que produção recebeu.
        for arquivo in ("shared/schema.sql", "shared/schema_multitenant.sql"):
            cur.execute((RAIZ / arquivo).read_text(encoding="utf-8"))
    yield conn
    conn.close()


@pytest.fixture
def cenario(conexao):
    """
    Dois inquilinos, cada um com sua loja e seu administrador.

    Tudo numa transação revertida ao final: o teste não pode deixar resíduo,
    ou a segunda execução parte de um estado diferente da primeira.
    """
    conexao.autocommit = False
    cur = conexao.cursor()
    cur.execute("""
        INSERT INTO organizations (name, slug, plan) VALUES ('ACME','t-acme','trial'), ('Beta','t-beta','trial');
        INSERT INTO stores (organization_id, name, api_key)
        VALUES ((SELECT id FROM organizations WHERE slug='t-acme'), 'Loja ACME', 'k-acme'),
               ((SELECT id FROM organizations WHERE slug='t-beta'), 'Loja Beta', 'k-beta');
        INSERT INTO users (email, password_hash, role)
        VALUES ('a@t.local','x','STORE_ADMIN'), ('b@t.local','x','STORE_ADMIN');
        INSERT INTO memberships (user_id, organization_id, role)
        VALUES ((SELECT id FROM users WHERE email='a@t.local'),
                (SELECT id FROM organizations WHERE slug='t-acme'), 'STORE_ADMIN'),
               ((SELECT id FROM users WHERE email='b@t.local'),
                (SELECT id FROM organizations WHERE slug='t-beta'), 'STORE_ADMIN');
    """)
    cur.execute("SELECT id FROM users WHERE email='a@t.local'")
    user_a = cur.fetchone()[0]
    cur.execute("SELECT id FROM users WHERE email='b@t.local'")
    user_b = cur.fetchone()[0]

    yield cur, user_a, user_b

    conexao.rollback()
    cur.close()
    conexao.autocommit = True


def como(cur, user_id, super_admin=False):
    """Assume o papel da aplicação e declara a identidade, como comInquilino()."""
    cur.execute("SET LOCAL ROLE visioncam_app")
    cur.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
    cur.execute("SELECT set_config('app.is_super_admin', %s, true)",
                ('on' if super_admin else 'off',))


def test_papel_da_aplicacao_nao_ignora_rls(conexao):
    """
    A pedra angular. `postgres` tem BYPASSRLS: se a aplicação usasse esse papel,
    toda política seria decorativa — pior que não ter, porque parece segura.
    """
    cur = conexao.cursor()
    cur.execute("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'visioncam_app'")
    linha = cur.fetchone()
    assert linha, "papel visioncam_app não existe"
    assert linha[0] is False, "visioncam_app ignora RLS — o isolamento seria decorativo"
    cur.close()


def test_cliente_nao_ve_loja_de_outro(cenario):
    cur, user_a, _ = cenario
    como(cur, user_a)

    cur.execute("SELECT name FROM stores ORDER BY name")
    nomes = [r[0] for r in cur.fetchall()]

    assert nomes == ['Loja ACME'], f"vazou: {nomes}"


def test_cliente_nao_ve_organizacao_de_outro(cenario):
    cur, user_a, _ = cenario
    como(cur, user_a)

    cur.execute("SELECT name FROM organizations ORDER BY name")
    assert [r[0] for r in cur.fetchall()] == ['ACME']


def test_filtro_explicito_por_id_alheio_nao_burla(cenario):
    """
    O ataque mais barato: pedir o id do outro na URL. Era exatamente o defeito
    de /api/analytics, onde `?store_id=` caía direto no WHERE.
    """
    cur, user_a, _ = cenario
    cur.execute("SELECT id FROM stores WHERE name='Loja Beta'")
    id_alheio = cur.fetchone()[0]

    como(cur, user_a)
    cur.execute("SELECT count(*) FROM stores WHERE id = %s", (id_alheio,))
    assert cur.fetchone()[0] == 0, "id alheio na consulta retornou dado"


def test_nao_da_para_escrever_na_organizacao_alheia(cenario):
    """Isolamento que só cobre leitura deixa o vizinho editar seus dados."""
    cur, user_a, _ = cenario
    cur.execute("SELECT id FROM stores WHERE name='Loja Beta'")
    id_alheio = cur.fetchone()[0]

    como(cur, user_a)
    cur.execute("UPDATE stores SET name='invadida' WHERE id = %s", (id_alheio,))
    assert cur.rowcount == 0, "conseguiu alterar loja de outro inquilino"

    cur.execute("DELETE FROM stores WHERE id = %s", (id_alheio,))
    assert cur.rowcount == 0, "conseguiu apagar loja de outro inquilino"


def test_sem_contexto_declarado_nao_ve_nada(cenario):
    """
    A propriedade que justifica a mudança toda: esquecer o contexto devolve
    vazio, não tudo. Com filtro em código, esquecer entregava a base inteira.
    """
    cur, _, _ = cenario
    cur.execute("SET LOCAL ROLE visioncam_app")
    cur.execute("SELECT set_config('app.user_id', '', true)")

    cur.execute("SELECT count(*) FROM stores")
    assert cur.fetchone()[0] == 0


def test_super_admin_enxerga_todos(cenario):
    cur, user_a, _ = cenario
    como(cur, user_a, super_admin=True)

    cur.execute("SELECT count(*) FROM stores WHERE name IN ('Loja ACME','Loja Beta')")
    assert cur.fetchone()[0] == 2


def _appliance_de(cur, slug, chave):
    """Cria um appliance na loja da organização indicada e devolve seu id."""
    cur.execute(
        """INSERT INTO appliances (store_id, label, edge_key, status)
           VALUES ((SELECT s.id FROM stores s
                      JOIN organizations o ON o.id = s.organization_id
                     WHERE o.slug = %s), 'caixa-01', %s, 'ATIVO')
           RETURNING id""",
        (slug, chave),
    )
    return cur.fetchone()[0]


def test_comando_de_um_cliente_e_invisivel_ao_outro(cenario):
    """
    A fila de comandos diz qual loja foi reiniciada e quando — é operação
    interna do concorrente, com a agravante de ser acionável: quem enxerga a
    fila alheia sabe qual appliance está instável e quando ninguém está olhando.
    """
    cur, user_a, _ = cenario
    id_beta = _appliance_de(cur, 't-beta', 'k-edge-beta')
    cur.execute(
        """INSERT INTO appliance_commands (appliance_id, comando, issued_email)
           VALUES (%s, 'reiniciar_engine', 'b@t.local')""",
        (id_beta,),
    )

    como(cur, user_a)
    cur.execute("SELECT count(*) FROM appliance_commands")
    assert cur.fetchone()[0] == 0, "leu a fila de comandos de outro inquilino"


def test_nao_da_para_comandar_appliance_alheio(cenario):
    """
    O que a RLS precisa impedir aqui não é leitura de dado: é a rota de
    comandos inserir para um appliance de outro cliente. Sem a política, um
    `appliance_id` trocado na requisição reiniciaria a loja do concorrente.
    """
    cur, user_a, _ = cenario
    id_beta = _appliance_de(cur, 't-beta', 'k-edge-beta-2')

    como(cur, user_a)

    # A rota faz um SELECT no appliance antes de inserir. É esse SELECT que
    # volta vazio — e é por isso que a inserção nunca chega a acontecer.
    cur.execute("SELECT count(*) FROM appliances WHERE id = %s", (id_beta,))
    assert cur.fetchone()[0] == 0, "enxergou o appliance de outro inquilino"

    # E mesmo pulando a checagem da aplicação, a escrita não passa: a política
    # vale para INSERT tanto quanto para SELECT.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(
            "INSERT INTO appliance_commands (appliance_id, comando) VALUES (%s, 'reiniciar_engine')",
            (id_beta,),
        )


def test_auditoria_de_um_cliente_e_invisivel_ao_outro(cenario):
    """Trilha vazada expõe a operação interna do concorrente."""
    cur, user_a, user_b = cenario
    cur.execute("SELECT id FROM organizations WHERE slug='t-beta'")
    org_b = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO audit_log (organization_id, user_id, actor_email, action) VALUES (%s,%s,%s,%s)",
        (org_b, user_b, 'b@t.local', 'store.delete'),
    )

    como(cur, user_a)
    cur.execute("SELECT count(*) FROM audit_log")
    assert cur.fetchone()[0] == 0, "leu a auditoria de outro inquilino"
