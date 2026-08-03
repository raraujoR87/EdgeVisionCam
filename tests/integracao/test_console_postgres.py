"""
Console do cliente, contra um Postgres de verdade.

Os testes em tests/test_console_cliente.py leem código-fonte: garantem que a
tela existe, que a rota audita, que o botão está lá. Nenhum deles executa uma
linha de SQL — e o console é, quase inteiro, SQL.

Este arquivo executa. Duas classes de defeito que só aparecem aqui:

  1. **Vazamento entre inquilinos nas consultas novas.** Toda rota do console
     depende da RLS para recortar. Uma que esqueça o envelope, ou que use um
     JOIN que contorne a política, devolve dados de outro cliente sem que
     nenhuma leitura de código perceba.

  2. **Agregação errada que parece certa.** Contagem multiplicada por fan-out
     de JOIN, dia sem evento sumindo da série, precisão exibida como 0% quando
     o certo é "ainda não há dado". Os três produzem números plausíveis.

Pulado quando DATABASE_URL_TESTE não está definida.
"""

import os
import pathlib

import pytest

psycopg = pytest.importorskip("psycopg2", reason="psycopg2 não instalado")

URL = os.environ.get("DATABASE_URL_TESTE")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL_TESTE não definida")

RAIZ = pathlib.Path(__file__).resolve().parents[2]

MINUTOS_ATE_OFFLINE = 15
DIAS_DA_SERIE = 14


@pytest.fixture(scope="module")
def conexao():
    conn = psycopg.connect(URL)
    conn.autocommit = True
    with conn.cursor() as cur:
        for arquivo in ("shared/schema.sql", "shared/schema_multitenant.sql"):
            cur.execute((RAIZ / arquivo).read_text(encoding="utf-8"))
    yield conn
    conn.close()


@pytest.fixture
def cenario(conexao):
    """
    Dois clientes. O primeiro tem histórico; o segundo existe só para provar
    que não aparece no primeiro.

    ACME: 1 loja, 2 appliances (um comunicando, um mudo), 5 eventos —
    2 confirmados, 1 falso alarme, 2 sem triagem. O buraco entre o evento mais
    antigo e o mais recente é proposital: é o dia vazio que a série precisa
    preservar.
    """
    conexao.autocommit = False
    cur = conexao.cursor()
    cur.execute("""
        INSERT INTO organizations (name, slug, plan) VALUES ('ACME','c-acme','trial'), ('Beta','c-beta','trial');

        INSERT INTO stores (organization_id, name, api_key)
        VALUES ((SELECT id FROM organizations WHERE slug='c-acme'), 'Loja ACME', 'ck-acme'),
               ((SELECT id FROM organizations WHERE slug='c-beta'), 'Loja Beta', 'ck-beta');

        INSERT INTO appliances (store_id, label, edge_key, status)
        VALUES ((SELECT id FROM stores WHERE api_key='ck-acme'), 'Caixa 1', 'ek-a1', 'ATIVO'),
               ((SELECT id FROM stores WHERE api_key='ck-acme'), 'Caixa 2', 'ek-a2', 'ATIVO'),
               ((SELECT id FROM stores WHERE api_key='ck-beta'), 'Beta 1',  'ek-b1', 'ATIVO');

        -- Um comunicando agora, um calado há duas horas.
        INSERT INTO hardware_status (appliance_id, store_id, last_seen)
        VALUES ((SELECT id FROM appliances WHERE edge_key='ek-a1'),
                (SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '2 minutes'),
               ((SELECT id FROM appliances WHERE edge_key='ek-a2'),
                (SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '2 hours');

        INSERT INTO events (store_id, analyzed_at, verdict, human_feedback, suspicion_score)
        VALUES
          ((SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '1 hour',  'SUSPICIOUS', 'TRUE_POSITIVE',  0.91),
          ((SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '3 hours', 'SUSPICIOUS', NULL,             0.77),
          ((SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '5 hours', 'CLEAR',      'FALSE_POSITIVE', 0.42),
          ((SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '2 days',  'SUSPICIOUS', 'TRUE_POSITIVE',  0.88),
          ((SELECT id FROM stores WHERE api_key='ck-acme'), NOW() - INTERVAL '5 days',  'SUSPICIOUS', NULL,             0.64),
          ((SELECT id FROM stores WHERE api_key='ck-beta'), NOW() - INTERVAL '1 hour',  'SUSPICIOUS', 'TRUE_POSITIVE',  0.95);

        INSERT INTO users (email, password_hash, role)
        VALUES ('acme@t.local','x','STORE_ADMIN'),
               ('beta@t.local','x','STORE_ADMIN'),
               ('viewer@t.local','x','STORE_VIEWER');

        INSERT INTO memberships (user_id, organization_id, role)
        VALUES ((SELECT id FROM users WHERE email='acme@t.local'),
                (SELECT id FROM organizations WHERE slug='c-acme'), 'STORE_ADMIN'),
               ((SELECT id FROM users WHERE email='beta@t.local'),
                (SELECT id FROM organizations WHERE slug='c-beta'), 'STORE_ADMIN'),
               ((SELECT id FROM users WHERE email='viewer@t.local'),
                (SELECT id FROM organizations WHERE slug='c-acme'), 'STORE_VIEWER');
    """)

    def uid(email):
        cur.execute("SELECT id FROM users WHERE email=%s", (email,))
        return cur.fetchone()[0]

    ids = {
        "acme": uid("acme@t.local"),
        "beta": uid("beta@t.local"),
        "viewer": uid("viewer@t.local"),
    }

    yield cur, ids

    conexao.rollback()
    cur.close()
    conexao.autocommit = True


def como(cur, user_id, super_admin=False):
    """Assume o papel da aplicação e declara a identidade, como comInquilino()."""
    cur.execute("SET LOCAL ROLE visioncam_app")
    cur.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
    cur.execute("SELECT set_config('app.is_super_admin', %s, true)",
                ('on' if super_admin else 'off',))


def um(cur):
    return cur.fetchone()


# ── /api/events ────────────────────────────────────────────────────

def test_lista_de_eventos_nao_vaza_entre_clientes(cenario):
    """
    A consulta da triagem não tem cláusula de inquilino nenhuma — é a RLS que
    recorta. Se a política cair, este teste é o que percebe.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("SELECT COUNT(*) FROM events")
    assert um(cur)[0] == 5, "o cliente vê eventos que não são dele"

    como(cur, ids["beta"])
    cur.execute("SELECT COUNT(*) FROM events")
    assert um(cur)[0] == 1


def test_store_id_alheio_na_url_devolve_vazio(cenario):
    """
    O ataque mais barato contra a triagem: trocar `?store_id=` para o id do
    concorrente. Era exatamente o defeito que existia em /api/analytics.
    """
    cur, ids = cenario
    cur.execute("SELECT id FROM stores WHERE api_key='ck-beta'")
    alheio = um(cur)[0]

    como(cur, ids["acme"])
    cur.execute("SELECT COUNT(*) FROM events WHERE store_id = %s", (alheio,))
    assert um(cur)[0] == 0, "store_id alheio na consulta retornou dado"


def test_resumo_da_fila_conta_certo(cenario):
    """
    Os contadores do cabeçalho da triagem. O resumo é calculado sobre o escopo
    (loja/organização) e NÃO sobre o filtro de trabalho: senão "pendentes: 0"
    apareceria só porque o usuário está olhando a aba dos já julgados.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("""
        SELECT COUNT(*) FILTER (WHERE e.human_feedback IS NULL)::int,
               COUNT(*) FILTER (WHERE e.verdict = 'SUSPICIOUS')::int,
               COUNT(*) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int,
               COUNT(*) FILTER (WHERE e.human_feedback = 'FALSE_POSITIVE')::int,
               COUNT(*) FILTER (WHERE e.analyzed_at >= NOW() - INTERVAL '24 hours')::int
          FROM events e
    """)
    pendentes, suspeitos, confirmados, falsos, ultimas_24h = um(cur)
    assert (pendentes, suspeitos, confirmados, falsos, ultimas_24h) == (2, 4, 2, 1, 3)


def test_classificar_evento_alheio_nao_altera_nada(cenario):
    """
    O PATCH da triagem confia na RLS para o UPDATE. rowCount zero é o que vira
    404 na resposta — e precisa ser zero de verdade.
    """
    cur, ids = cenario
    cur.execute("SELECT id FROM events WHERE store_id = (SELECT id FROM stores WHERE api_key='ck-beta')")
    alheio = um(cur)[0]

    como(cur, ids["acme"])
    cur.execute("UPDATE events SET human_feedback='FALSE_POSITIVE' WHERE id = %s", (alheio,))
    assert cur.rowcount == 0, "classificou o evento de outro cliente"


def test_viewer_nao_tem_vinculo_que_autorize_julgar(cenario):
    """
    A rota checa a associação com AQUELA organização antes de aceitar a
    classificação. O papel do token é global e não serve: a mesma pessoa pode
    ser operadora numa rede e observadora em outra.
    """
    cur, ids = cenario
    cur.execute("SELECT id FROM organizations WHERE slug='c-acme'")
    org = um(cur)[0]

    como(cur, ids["viewer"])
    cur.execute("""
        SELECT 1 FROM memberships
         WHERE user_id = %s AND organization_id = %s
           AND role IN ('STORE_ADMIN','STORE_OPERATOR') LIMIT 1
    """, (ids["viewer"], org))
    assert um(cur) is None, "o observador passaria pela checagem da rota"

    como(cur, ids["acme"])
    cur.execute("""
        SELECT 1 FROM memberships
         WHERE user_id = %s AND organization_id = %s
           AND role IN ('STORE_ADMIN','STORE_OPERATOR') LIMIT 1
    """, (ids["acme"], org))
    assert um(cur) is not None, "o administrador seria barrado por engano"


# ── /api/console/resumo ────────────────────────────────────────────

def test_serie_preserva_dias_sem_evento(cenario):
    """
    A lacuna é o dado: é assim que um appliance caído aparece no gráfico. Um
    filtro no WHERE externo, em vez de dentro da subconsulta, descartaria as
    linhas dos dias vazios junto com os eventos — e o gráfico ficaria com 3
    barras coladas, sugerindo atividade contínua.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute(f"""
        WITH dias AS (
          SELECT generate_series((NOW() - INTERVAL '{DIAS_DA_SERIE - 1} days')::date,
                                 NOW()::date, '1 day')::date AS dia
        ), recentes AS (
          SELECT e.id, e.analyzed_at, e.verdict, e.human_feedback
            FROM events e JOIN stores s ON s.id = e.store_id
           WHERE e.analyzed_at >= NOW() - INTERVAL '{DIAS_DA_SERIE} days'
        )
        SELECT d.dia, COUNT(r.id)::int
          FROM dias d LEFT JOIN recentes r ON r.analyzed_at::date = d.dia
         GROUP BY d.dia ORDER BY d.dia
    """)
    linhas = cur.fetchall()

    assert len(linhas) == DIAS_DA_SERIE, "a série perdeu dias"
    assert sum(n for _, n in linhas) == 5, "a série perdeu ou duplicou eventos"
    assert any(n == 0 for _, n in linhas), "nenhum dia vazio — o buraco sumiu"


def test_contagem_por_loja_nao_multiplica_com_dois_appliances(cenario):
    """
    O defeito clássico: juntar appliances e events na mesma linha multiplica um
    pelo outro. Com 2 appliances e 5 eventos, um JOIN ingênuo conta 10.

    Esta loja tem exatamente 2 appliances de propósito — com um só, o bug seria
    invisível.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute(f"""
        SELECT s.name,
               (SELECT COUNT(*)::int FROM appliances a WHERE a.store_id = s.id),
               (SELECT COUNT(*)::int FROM appliances a
                  JOIN hardware_status h ON h.appliance_id = a.id
                 WHERE a.store_id = s.id
                   AND h.last_seen >= NOW() - INTERVAL '{MINUTOS_ATE_OFFLINE} minutes'),
               (SELECT COUNT(*)::int FROM events e
                 WHERE e.store_id = s.id AND e.analyzed_at >= NOW() - INTERVAL '24 hours'),
               (SELECT COUNT(*)::int FROM events e
                 WHERE e.store_id = s.id AND e.human_feedback IS NULL)
          FROM stores s ORDER BY s.name
    """)
    linhas = cur.fetchall()

    assert len(linhas) == 1, "apareceu loja de outro cliente"
    nome, appliances, online, eventos_24h, pendentes = linhas[0]
    assert nome == 'Loja ACME'
    assert appliances == 2
    assert online == 1, "o appliance calado há 2h foi contado como no ar"
    assert eventos_24h == 3, "contagem multiplicada pelo número de appliances"
    assert pendentes == 2


def test_appliance_mudo_ainda_conta_como_instalado(cenario):
    """
    Um dispositivo que parou de reportar não pode desaparecer da contagem: é
    justamente ele que o cliente precisa ver. Sumir seria o pior resultado —
    a tela ficaria idêntica à de uma loja saudável com um aparelho a menos.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("""
        SELECT COUNT(*)::int FROM appliances a
         WHERE a.store_id = (SELECT id FROM stores WHERE api_key='ck-acme')
    """)
    assert um(cur)[0] == 2


# ── /api/console/relatorios ────────────────────────────────────────

def test_precisao_e_cobertura_batem_com_a_triagem(cenario):
    """
    3 julgados de 5: cobertura 60%. Desses, 2 procediam: precisão ~67%.
    Números conferidos à mão porque é o que o cliente leva para a reunião.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("""
        SELECT COUNT(*)::int,
               COUNT(*) FILTER (WHERE human_feedback IS NOT NULL)::int,
               COUNT(*) FILTER (WHERE human_feedback = 'TRUE_POSITIVE')::int
          FROM events e
    """)
    total, julgados, confirmados = um(cur)
    assert (total, julgados, confirmados) == (5, 3, 2)

    assert julgados / total == 0.6
    assert round(confirmados / julgados, 2) == 0.67
    # 3 julgados está longe do piso de 20: a tela precisa dizer que o número
    # ainda não significa nada.
    assert julgados < 20


def test_sem_julgamento_a_precisao_e_indefinida_e_nao_zero(cenario):
    """
    Zero afirmaria que o sistema errou tudo. O certo é "ainda não foi
    avaliado" — e a diferença entre as duas frases decide uma renovação.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("UPDATE events SET human_feedback = NULL")
    cur.execute("""
        SELECT COUNT(*) FILTER (WHERE human_feedback IS NOT NULL)::int,
               COUNT(*) FILTER (WHERE human_feedback = 'TRUE_POSITIVE')::int
          FROM events
    """)
    julgados, confirmados = um(cur)
    assert julgados == 0
    precisao = (confirmados / julgados) if julgados > 0 else None
    assert precisao is None


def test_distribuicao_por_hora_cobre_o_dia_inteiro(cenario):
    """
    24 linhas sempre, mesmo sem evento em quase todas. Um eixo com buracos
    sugere que a loja fecha nas horas ausentes.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("""
        WITH horas AS (SELECT generate_series(0, 23) AS hora)
        SELECT h.hora, COUNT(e.id)::int
          FROM horas h
          LEFT JOIN (SELECT e.id, e.analyzed_at FROM events e
                       JOIN stores s ON s.id = e.store_id) e
                 ON EXTRACT(HOUR FROM e.analyzed_at AT TIME ZONE 'America/Sao_Paulo') = h.hora
         GROUP BY h.hora ORDER BY h.hora
    """)
    linhas = cur.fetchall()
    assert len(linhas) == 24
    assert sum(n for _, n in linhas) == 5


def test_relatorio_de_um_cliente_ignora_o_outro(cenario):
    """
    O relatório é o que vira número em reunião. Vazar aqui não é só falha de
    privacidade: entrega o volume de perdas do concorrente.
    """
    cur, ids = cenario
    como(cur, ids["beta"])
    cur.execute("""
        SELECT COUNT(*)::int FROM events e JOIN stores s ON s.id = e.store_id
         WHERE e.analyzed_at >= NOW() - INTERVAL '30 days'
    """)
    assert um(cur)[0] == 1, "o relatório somou eventos de outro cliente"


# ── /api/me ────────────────────────────────────────────────────────

def test_me_lista_apenas_as_organizacoes_do_usuario(cenario):
    """
    É o que decide o que o menu mostra e qual organização o console abre. Uma
    organização a mais aqui é o nome de outro cliente aparecendo no seletor.
    """
    cur, ids = cenario
    como(cur, ids["acme"])
    cur.execute("""
        SELECT o.name, COALESCE(m.role, 'STORE_VIEWER')
          FROM organizations o
          LEFT JOIN memberships m ON m.organization_id = o.id AND m.user_id = %s
         ORDER BY o.name
    """, (ids["acme"],))
    assert cur.fetchall() == [('ACME', 'STORE_ADMIN')]


def test_conta_sem_associacao_enxerga_lista_vazia(cenario):
    """
    Existe em produção: usuários criados antes da migração multi-tenant. O
    console precisa distinguir "sem acesso" de "sem dados" — senão a pessoa vê
    quatro painéis zerados e conclui que o produto está quebrado.
    """
    cur, _ = cenario
    cur.execute("INSERT INTO users (email, password_hash, role) VALUES ('orfao@t.local','x','STORE_VIEWER') RETURNING id")
    orfao = um(cur)[0]

    como(cur, orfao)
    cur.execute("SELECT COUNT(*) FROM organizations")
    assert um(cur)[0] == 0
    cur.execute("SELECT COUNT(*) FROM stores")
    assert um(cur)[0] == 0
    cur.execute("SELECT COUNT(*) FROM events")
    assert um(cur)[0] == 0


def test_super_admin_ve_todos_os_clientes(cenario):
    cur, ids = cenario
    como(cur, ids["acme"], super_admin=True)
    cur.execute("SELECT COUNT(*) FROM organizations WHERE slug IN ('c-acme','c-beta')")
    assert um(cur)[0] == 2
    cur.execute("SELECT COUNT(*) FROM events")
    assert um(cur)[0] == 6
