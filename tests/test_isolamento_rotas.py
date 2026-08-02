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
ROTAS_DE_INQUILINO = ["stores/route.ts"]


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
