"""
Isolamento entre inquilinos nas rotas da nuvem.

Estes testes leem o código-fonte, não executam requisições — não há Postgres com
RLS neste ambiente. Ainda assim travam a propriedade que importa: que as rotas
NÃO carreguem o isolamento no próprio corpo.

Isso soa invertido, e é intencional. Filtro em código falha em aberto: um WHERE
esquecido devolve dados de outro cliente e passa em revisão porque a rota
responde certo. Com RLS, esquecer devolve zero linhas. O teste garante que o
mecanismo usado é o segundo.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API = os.path.join(RAIZ, "ui", "app", "api")

# Rotas que servem dado pertencente a cliente e são acessadas por sessão de
# usuário. Ingestão (telemetry/webhook) e provisionamento usam outra credencial
# e estão fora deste conjunto de propósito.
ROTAS_DE_INQUILINO = [
    "stores/route.ts",
    "users/route.ts",
    "analytics/route.ts",
    "organizations/route.ts",
    "audit/route.ts",
]


def _ler(caminho):
    with open(os.path.join(API, caminho), encoding="utf-8") as arquivo:
        return arquivo.read()


def test_rotas_usam_o_envelope_de_inquilino():
    """
    Consultar fora de `comInquilino()` usa a conexão de serviço, que ignora a
    RLS. Seria voltar ao filtro em código sem ninguém perceber.
    """
    for rota in ROTAS_DE_INQUILINO:
        conteudo = _ler(rota)
        assert "comInquilino" in conteudo, f"{rota} não usa o envelope de inquilino"
        assert "contextoDoToken" in conteudo, f"{rota} não deriva contexto do token"


def test_rotas_migradas_nao_consultam_pelo_atalho():
    """
    `query()` de db.ts vai direto ao pool, sem contexto. Numa rota já migrada,
    uma chamada dessas é um vazamento em potencial.
    """
    for rota in ROTAS_DE_INQUILINO:
        conteudo = _ler(rota)
        assert not re.search(r"\bawait query\(", conteudo), \
            f"{rota} ainda usa query() direto, que ignora a RLS"


def test_toda_escrita_deixa_rastro():
    """
    Governança exige responder "quem apagou esta loja?". Uma escrita sem
    auditoria é uma pergunta sem resposta.
    """
    conteudo = _ler("stores/route.ts")
    for metodo in ("POST", "PUT", "DELETE"):
        corpo = re.search(
            rf"export async function {metodo}\(request: Request\)[\s\S]*?(?=\nexport async function |\Z)",
            conteudo,
        )
        assert corpo, f"{metodo} não encontrado"
        assert "registrarAuditoria" in corpo.group(0), f"{metodo} escreve sem auditar"


def test_delete_registra_o_nome_antes_de_perder_a_linha():
    """
    Depois do DELETE a linha não existe. Sem guardar o nome no detalhe, a
    trilha diria apenas "apagou a loja 7" e ninguém saberia qual era.
    """
    conteudo = _ler("stores/route.ts")
    corpo = re.search(r"export async function DELETE[\s\S]*", conteudo).group(0)
    assert "RETURNING id, organization_id, name" in corpo
    assert re.search(r"detail:\s*\{\s*name:", corpo)


def test_store_admin_nao_escolhe_a_organizacao():
    """
    Se um STORE_ADMIN pudesse mandar `organization_id` no corpo, criaria loja
    dentro da organização de outro cliente. A organização vem da associação
    dele, nunca da requisição.
    """
    conteudo = _ler("stores/route.ts")
    corpo = re.search(r"export async function POST[\s\S]*?(?=\nexport async function )", conteudo).group(0)
    assert "orgsQueAdministra" in corpo
    assert re.search(r"if \(!superAdmin\)[\s\S]{0,400}orgId = minhas\[0\]", corpo), \
        "o organization_id do corpo não é sobrescrito para quem não é SUPER_ADMIN"


def test_limite_do_plano_e_verificado_antes_de_criar():
    conteudo = _ler("stores/route.ts")
    corpo = re.search(r"export async function POST[\s\S]*?(?=\nexport async function )", conteudo).group(0)
    pos_limite = corpo.index("dentroDoLimite")
    pos_insert = corpo.index("INSERT INTO stores")
    assert pos_limite < pos_insert, "cria a loja antes de conferir o limite do plano"


def test_recurso_alheio_e_indistinguivel_de_inexistente():
    """
    Responder 403 para "existe mas não é seu" e 404 para "não existe" permite
    enumerar os ids de outros clientes. As duas respostas têm de ser iguais.
    """
    conteudo = _ler("stores/route.ts")
    assert conteudo.count("'Loja não encontrada.'") >= 2
    assert "distinguir os dois casos revelaria quais ids existem" in conteudo


def test_chave_de_loja_vem_de_fonte_criptografica():
    """
    A api_key autentica o appliance. randomUUID serve como identificador, não
    como credencial.
    """
    conteudo = _ler("stores/route.ts")
    assert "crypto.randomBytes(24)" in conteudo
    assert "crypto.randomUUID()" not in conteudo


def test_pool_unico_no_processo():
    """
    Dois pools dobram as conexões contra o Postgres — recurso limitado e
    compartilhado no Supabase — e duplicam a lógica de SSL.
    """
    with open(os.path.join(API, "tenant.ts"), encoding="utf-8") as arquivo:
        tenant = arquivo.read()
    assert "from './db'" in tenant and "obterPool" in tenant
    assert "new Pool(" not in tenant, "tenant.ts abre o próprio pool"


# ── Gestão de equipe ───────────────────────────────────────────────

def test_convite_nao_redefine_senha_de_conta_existente():
    """
    Reaproveitar a conta ao convidar é necessário — um consultor atende várias
    redes. Mas redefinir a senha nesse caminho viraria tomada de conta: bastaria
    convidar o e-mail de alguém para escolher a senha dele.
    """
    conteudo = _ler("users/route.ts")
    corpo = re.search(r"export async function POST[\s\S]*?(?=\nexport async function )", conteudo).group(0)
    # gerarHash só pode aparecer no ramo de criação.
    assert corpo.count("gerarHash(password)") == 1
    assert re.search(r"if \(existente\.rowCount\)[\s\S]{0,200}else \{", corpo), \
        "não distingue conta existente de conta nova"
    assert "não pode redefinir a senha" in corpo


def test_papel_vem_de_lista_fechada():
    """
    Aceitar papel arbitrário deixa o valor cair na coluna e ser interpretado por
    qualquer checagem futura que compare string solta.
    """
    conteudo = _ler("users/route.ts")
    assert "papelDeOrganizacaoValido(role)" in conteudo

    papeis = _ler("papeis.ts")
    lista = re.search(r"PAPEIS_DE_ORGANIZACAO = \[[\s\S]*?\]", papeis).group(0)
    # SUPER_ADMIN não é atribuível por convite: seria escalada de privilégio.
    assert "SUPER_ADMIN," not in lista


def test_organizacao_nao_fica_sem_administrador():
    """
    Sem esta checagem, um STORE_ADMIN se remove por engano e ninguém mais
    convida equipe — só um SUPER_ADMIN destrava, o que vira chamado de suporte.
    """
    conteudo = _ler("users/route.ts")
    corpo = re.search(r"export async function DELETE[\s\S]*", conteudo).group(0)
    assert "última administração" in corpo
    assert re.search(r"COUNT\(\*\)::int AS n FROM memberships[\s\S]{0,120}STORE_ADMIN", corpo)


def test_remover_associacao_nao_apaga_a_conta():
    """Quem atende três redes e sai de uma mantém acesso às outras duas."""
    conteudo = _ler("users/route.ts")
    corpo = re.search(r"export async function DELETE[\s\S]*", conteudo).group(0)
    assert "DELETE FROM memberships" in corpo
    assert "DELETE FROM users" not in corpo


def test_store_admin_nao_convida_para_organizacao_alheia():
    conteudo = _ler("users/route.ts")
    corpo = re.search(r"export async function POST[\s\S]*?(?=\nexport async function )", conteudo).group(0)
    assert "Organização fora do seu escopo" in corpo
    assert "minhas.includes(orgId)" in corpo


# ── Vazamento por parâmetro de URL ─────────────────────────────────

def test_analytics_nao_aceita_loja_pela_query_string():
    """
    A versão anterior fazia:

        const store_id = searchParams.get('store_id') || payload.store_id;

    O id vinha da URL sem verificação de posse. Qualquer autenticado lia os
    indicadores de qualquer loja trocando um número — sem forjar token nem
    adivinhar credencial.
    """
    conteudo = _ler("analytics/route.ts")
    # Só linhas de código: o comentário que documenta o defeito precisa citá-lo.
    codigo = "\n".join(
        l for l in conteudo.splitlines()
        if not l.lstrip().startswith(("*", "//", "/*"))
    )
    assert not re.search(r"searchParams\.get\('store_id'\)\s*\|\|", codigo), \
        "o store_id da URL ainda cai direto no filtro"
    assert "comInquilino" in codigo


def test_papel_legado_esta_num_lugar_so():
    """
    A checagem ['admin','SUPER_ADMIN'] replicada em cinco arquivos é como um
    caminho fica mais permissivo que os outros: basta alguém corrigir quatro.
    """
    literais = 0
    for pasta, _, arquivos in os.walk(API):
        for arquivo in arquivos:
            if not arquivo.endswith(".ts") or arquivo == "papeis.ts":
                continue
            with open(os.path.join(pasta, arquivo), encoding="utf-8") as f:
                if re.search(r"\['admin',\s*'SUPER_ADMIN'\]", f.read()):
                    literais += 1
    assert literais == 0, f"{literais} arquivo(s) repetem a checagem em vez de usar papeis.ts"


def test_auditoria_nao_derruba_a_operacao():
    """
    O código de provisionamento já existe no banco quando a auditoria roda.
    Falhar ali deixaria o técnico sem código por um problema de log.
    """
    conteudo = _ler("provisioning/route.ts")
    assert "Falha ao auditar emissao" in conteudo
    assert re.search(r"catch \(erroAuditoria\)", conteudo)


# ── Organizações e auditoria ───────────────────────────────────────

def test_limites_do_plano_nao_vem_da_requisicao():
    """
    Aceitar max_stores do corpo permitiria a quem alcançasse a rota comprar um
    upgrade sem passar pelo comercial. Os limites saem da tabela de planos.
    """
    conteudo = _ler("organizations/route.ts")
    assert "PLANOS[planoEscolhido]" in conteudo
    assert "limites?.max_stores" in conteudo
    corpo = re.search(r"export async function PUT[\s\S]*", conteudo).group(0)
    assert "max_stores" not in re.search(r"const \{ id, name, plan, status \}", corpo).group(0)


def test_suspensao_tem_acao_propria_na_trilha():
    """
    Suspensão é evento comercial. Quem audita depois procura por ela, não por
    "organization.update".
    """
    conteudo = _ler("organizations/route.ts")
    assert "organization.${status}" in conteudo


def test_auditoria_e_somente_leitura():
    """
    Trilha alterável pela aplicação não serve como trilha: a primeira coisa que
    alguém faria ao abusar do sistema seria apagar o próprio rastro.
    """
    conteudo = _ler("audit/route.ts")
    for metodo in ("POST", "PUT", "PATCH", "DELETE"):
        assert f"export async function {metodo}" not in conteudo, \
            f"audit expõe {metodo}"


def test_auditoria_tem_teto_de_paginacao():
    """`?limit=999999` viraria varredura que trava o banco de todos."""
    conteudo = _ler("audit/route.ts")
    assert "LIMITE_MAXIMO" in conteudo
    assert "Math.min(" in conteudo


def test_auditoria_restrita_a_quem_administra():
    conteudo = _ler("audit/route.ts")
    assert "ehSuperAdmin(sessao.role)" in conteudo
    assert "STORE_ADMIN" in conteudo
