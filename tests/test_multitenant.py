"""
Fundação multi-tenant: hierarquia, isolamento e governança.

Um vazamento entre inquilinos não é um bug comum — é incidente de dados, e o
tipo que passa em revisão porque a rota "funciona". Estes testes travam as
propriedades estruturais que impedem isso.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _ler(caminho):
    with open(os.path.join(RAIZ, caminho), encoding="utf-8") as arquivo:
        return arquivo.read()


SCHEMA = "shared/schema_multitenant.sql"
TENANT = "ui/app/api/tenant.ts"


# ── Hierarquia ─────────────────────────────────────────────────────

def test_existe_a_entidade_cliente():
    """
    `users.store_id` amarrava um usuário a UMA loja. Uma rede com 5 lojas
    precisaria de 5 contas, sem ninguém enxergando o conjunto — trava no
    segundo cliente, não no milésimo.
    """
    sql = _ler(SCHEMA)
    assert "CREATE TABLE IF NOT EXISTS organizations" in sql
    assert "ADD COLUMN IF NOT EXISTS organization_id" in sql


def test_papel_e_por_associacao_nao_por_usuario():
    """
    Papel como coluna do usuário é um papel para a vida toda. Como linha de
    associação, a mesma pessoa pode ser STORE_ADMIN numa rede e VIEWER em
    outra — o caso real do gestor regional e da franquia.
    """
    sql = _ler(SCHEMA)
    assert "CREATE TABLE IF NOT EXISTS memberships" in sql
    assert re.search(r"memberships[\s\S]{0,600}organization_id\s+INTEGER\s+NOT NULL", sql)
    assert re.search(r"memberships[\s\S]{0,600}role\s+VARCHAR", sql)


def test_migracao_e_idempotente():
    """
    Migração que só roda uma vez vira operação manual arriscada. Toda criação
    precisa ser condicional.
    """
    sql = _ler(SCHEMA)
    criacoes = re.findall(r"CREATE TABLE (IF NOT EXISTS )?", sql)
    assert all(c.strip() for c in criacoes), "há CREATE TABLE sem IF NOT EXISTS"
    for coluna in re.findall(r"ADD COLUMN (IF NOT EXISTS )?", sql):
        assert coluna.strip(), "há ADD COLUMN sem IF NOT EXISTS"


def test_nenhuma_loja_fica_orfa():
    """Toda loja existente precisa acabar dentro de alguma organização."""
    sql = _ler(SCHEMA)
    assert "WHERE s.organization_id IS NULL" in sql
    assert "UPDATE stores s" in sql


# ── Isolamento no banco ────────────────────────────────────────────

def test_rls_ativa_nas_tabelas_com_dado_de_cliente():
    sql = _ler(SCHEMA)
    for tabela in ("organizations", "stores", "appliances", "events", "audit_log"):
        assert f"ALTER TABLE {tabela}" in sql and "ENABLE ROW LEVEL SECURITY" in sql, \
            f"{tabela} sem RLS"
        assert re.search(rf"CREATE POLICY \w+ ON {tabela}", sql), f"{tabela} sem política"


def test_super_admin_atravessa_o_isolamento():
    """O administrador global precisa ver tudo — mas por uma via explícita."""
    sql = _ler(SCHEMA)
    assert "app_is_super_admin()" in sql
    assert sql.count("app_is_super_admin() OR") >= 4


def test_contexto_ausente_nao_libera_tudo():
    """
    Uma conexão sem contexto tem de enxergar ZERO linhas. `current_setting` com
    o segundo argumento TRUE devolve NULL em vez de erro; sem ele, a ausência
    do contexto viraria exceção — e a tentação seria capturá-la e seguir.
    """
    sql = _ler(SCHEMA)
    assert "current_setting('app.user_id', TRUE)" in sql
    assert "NULLIF" in sql


# ── Contexto na aplicação ──────────────────────────────────────────

def test_usa_set_local_e_nao_set():
    """
    `SET` vale pela sessão inteira. Numa conexão de pool, a próxima requisição
    herdaria a identidade da anterior — um cliente veria os dados de quem usou
    a conexão antes. `set_config(..., true)` é o equivalente a SET LOCAL.
    """
    ts = _ler(TENANT)
    assert "set_config($1, $2, true)" in ts
    # A forma perigosa não pode aparecer.
    assert not re.search(r"query\(\s*['\"]SET\s+app\.", ts), "usa SET em vez de SET LOCAL"


def test_contexto_e_parametrizado():
    """userId vem de um token; concatenar em SQL o tornaria injetável."""
    ts = _ler(TENANT)
    assert "set_config($1, $2, true)" in ts
    assert not re.search(r"app\.user_id\s*=\s*\$\{", ts), "interpola userId no SQL"


def test_transacao_sempre_encerra_e_devolve_a_conexao():
    """
    Sem release no finally o pool esgota sob carga, e o sintoma aparece como
    lentidão geral — não como bug desta rota.
    """
    ts = _ler(TENANT)
    assert "ROLLBACK" in ts and "COMMIT" in ts
    assert re.search(r"finally\s*\{[\s\S]{0,300}cliente\.release\(\)", ts)


# ── Governança ─────────────────────────────────────────────────────

def test_auditoria_e_atomica_com_a_acao():
    """
    Registrar fora da transação produz log de coisas que não aconteceram
    (rollback depois do log) ou ações sem registro (falha ao logar).
    """
    ts = _ler(TENANT)
    assert re.search(r"registrarAuditoria\(\s*\n?\s*cliente: PoolClient", ts), \
        "auditoria não recebe o cliente da transação"


def test_auditoria_sobrevive_a_remocao_do_usuario():
    """
    "Quem apagou esta loja?" continua tendo de ter resposta depois que a pessoa
    sai da empresa.
    """
    sql = _ler(SCHEMA)
    assert re.search(r"audit_log[\s\S]{0,800}actor_email", sql)
    assert re.search(r"audit_log[\s\S]{0,800}user_id\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL", sql)


def test_plano_tem_teto_explicito():
    """
    Sem limite, um cliente em trial provisiona sem parar — e o custo aparece na
    fatura antes de aparecer no painel.
    """
    sql = _ler(SCHEMA)
    assert "max_stores" in sql and "max_appliances" in sql
    assert "dentroDoLimite" in _ler(TENANT)


def test_suspender_nao_apaga():
    """Inadimplência não pode destruir os dados do cliente."""
    sql = _ler(SCHEMA)
    assert re.search(r"organizations[\s\S]{0,900}status\s+VARCHAR", sql)
    assert "'ativa'" in sql


def test_ingestao_do_appliance_nao_le_a_base_inteira():
    """
    Telemetria chega por x-store-api-key, sem sessão de usuário. A saída não
    pode ser desligar a RLS: uma chave de appliance vazada viraria leitura de
    todos os inquilinos.
    """
    sql = _ler(SCHEMA)
    assert "visioncam_ingest" in sql
    assert "GRANT INSERT ON events" in sql
    # O papel de ingestão não pode ter SELECT irrestrito em events.
    assert not re.search(r"GRANT SELECT[^;]*\bevents\b[^;]*TO visioncam_ingest", sql)


# ── O papel da conexão ─────────────────────────────────────────────

def test_transacao_assume_papel_sem_bypass():
    """
    Descoberto no Supabase: `postgres` — o papel da DATABASE_URL — tem
    rolbypassrls = true. Politicas nao se aplicam a ele.

    Declarar o contexto sem trocar de papel produz isolamento decorativo: as
    politicas existem, o SET LOCAL roda, e nada disso vale. E o pior resultado
    possivel, porque parece seguro.
    """
    ts = _ler(TENANT)
    assert "SET LOCAL ROLE" in ts
    assert "visioncam_app" in ts
    # A troca tem de vir antes de qualquer consulta do chamador.
    assert ts.index("SET LOCAL ROLE") < ts.index("trabalho(cliente)")


def test_nome_do_papel_nao_vem_de_requisicao():
    """
    SET ROLE nao aceita parametro. Um valor externo interpolado ali seria
    injecao de SQL com troca de privilegio junto.
    """
    ts = _ler(TENANT)
    assert "const PAPEL_DA_APLICACAO = 'visioncam_app'" in ts
    assert "${PAPEL_DA_APLICACAO}" in ts


def test_migracao_cria_o_papel_e_da_associacao_ao_postgres():
    sql = _ler(SCHEMA)
    assert "CREATE ROLE visioncam_app NOLOGIN NOBYPASSRLS" in sql
    assert "GRANT visioncam_app TO postgres" in sql
