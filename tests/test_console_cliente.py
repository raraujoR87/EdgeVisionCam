"""
Console do cliente.

O produto que se vende é este: o lojista e a equipe dele abrem uma tela, veem
os alertas, assistem ao clipe e dizem se procede. Enquanto isso não existia,
havia um detector e o back-office do fornecedor — não um produto.

Estes testes travam as propriedades que, se regredirem, devolvem o sistema ao
estado anterior sem que nada quebre visivelmente.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(RAIZ, "ui", "app")
CONSOLE = os.path.join(APP, "console")


def _ler(*partes):
    with open(os.path.join(*partes), encoding="utf-8") as arquivo:
        return arquivo.read()


TELAS = {
    "page.tsx": "painel",
    "eventos/page.tsx": "triagem",
    "relatorios/page.tsx": "relatórios",
    "equipe/page.tsx": "equipe",
}


# ── Existência ─────────────────────────────────────────────────────

def test_console_existe_separado_do_painel_do_fornecedor():
    """
    Enquanto cliente e fornecedor dividem o mesmo layout, toda tela nova
    precisa lembrar de se esconder do público errado. Sob /console, o que é do
    cliente é do cliente por construção.
    """
    assert os.path.isdir(CONSOLE)
    assert os.path.isfile(os.path.join(CONSOLE, "layout.tsx"))
    for arquivo, nome in TELAS.items():
        assert os.path.isfile(os.path.join(CONSOLE, arquivo)), f"falta a tela de {nome}"


def test_todas_as_telas_estao_na_navegacao():
    """Tela sem link é tela que não existe."""
    layout = _ler(CONSOLE, "layout.tsx")
    for href in ("/console", "/console/eventos", "/console/relatorios", "/console/equipe"):
        assert f"href: '{href}'" in layout, f"{href} fora do menu"


def test_layout_nao_exporta_alem_do_componente():
    """
    Um arquivo de layout do Next.js só pode exportar o componente e campos de
    configuração conhecidos. Exportar um hook dali quebra o build — e quebra na
    checagem de tipos, não na compilação, então `tsc --noEmit` passa e o erro só
    aparece no deploy. Já custou três deploys neste projeto.
    """
    layout = _ler(CONSOLE, "layout.tsx")
    exportados = re.findall(r"^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)",
                            layout, re.MULTILINE)
    assert exportados == [], f"layout.tsx exporta {exportados} além do default"
    assert os.path.isfile(os.path.join(CONSOLE, "contexto.tsx")), \
        "o contexto precisa morar fora do layout"


# ── Triagem: a ação central ────────────────────────────────────────

def test_triagem_permite_classificar_o_alerta():
    """
    É a ação que o produto vende. Sem ela, o cliente tem uma lista de vídeos.
    """
    tela = _ler(CONSOLE, "eventos", "page.tsx")
    assert "TRUE_POSITIVE" in tela and "FALSE_POSITIVE" in tela
    assert "'PATCH'" in tela


def test_triagem_permite_desfazer():
    """
    Um fiscal que não pode corrigir um clique errado passa a não clicar — e a
    fila deixa de refletir a realidade, que é justamente o dado do qual sai a
    medição de acurácia.
    """
    tela = _ler(CONSOLE, "eventos", "page.tsx")
    assert "julgar(atual, null)" in tela, "não há como desfazer uma classificação"


def test_triagem_abre_na_fila_e_nao_na_lista_completa():
    """
    Abrir em "tudo" transforma triagem em rolar procurando o que falta julgar.
    """
    tela = _ler(CONSOLE, "eventos", "page.tsx")
    assert re.search(r"useState\(params\.get\('pendentes'\).*'pendentes'", tela), \
        "a triagem não abre na fila de pendentes"


def test_triagem_mostra_o_clipe():
    """Ninguém classifica furto lendo um score."""
    tela = _ler(CONSOLE, "eventos", "page.tsx")
    assert "<video" in tela and "video_url" in tela


def test_triagem_trata_clipe_ausente():
    """
    O dispositivo detecta e o vídeo pode não chegar ao armazenamento. Sem este
    ramo, a tela mostra um player quebrado e o fiscal julga no escuro.
    """
    tela = _ler(CONSOLE, "eventos", "page.tsx")
    assert "Clipe indisponível" in tela


# ── Autorização ────────────────────────────────────────────────────

def test_viewer_nao_classifica_na_rota():
    """
    Esconder o botão não é controle de acesso. A regra tem de valer na API,
    e o papel que vale é o da associação com AQUELA organização — o token
    carrega um valor global só, e a mesma pessoa pode ser operadora numa rede
    e observadora em outra.
    """
    rota = _ler(APP, "api", "events", "route.ts")
    assert "memberships" in rota
    assert "STORE_ADMIN', 'STORE_OPERATOR'" in rota
    assert "403" in rota


def test_classificacao_fica_auditada():
    """
    Num sistema que pode levar à abordagem de uma pessoa, "quem classificou
    este evento como furto" precisa ter resposta — inclusive num eventual
    questionamento jurídico.
    """
    rota = _ler(APP, "api", "events", "route.ts")
    assert "registrarAuditoria" in rota
    assert "event.feedback" in rota


def test_rotas_do_console_passam_pela_rls():
    """
    Consultar fora do envelope de inquilino não é atalho: é consulta que devolve
    dados de outro cliente, porque a conexão de serviço ignora RLS sem o
    SET LOCAL ROLE.
    """
    for rota in ("me/route.ts", "console/resumo/route.ts",
                 "console/relatorios/route.ts", "events/route.ts"):
        conteudo = _ler(APP, "api", *rota.split("/"))
        assert "comInquilino" in conteudo, f"{rota} consulta fora do envelope de RLS"


def test_rotas_do_console_exigem_autenticacao():
    for rota in ("me/route.ts", "console/resumo/route.ts", "console/relatorios/route.ts"):
        conteudo = _ler(APP, "api", *rota.split("/"))
        assert "sessaoDaRequisicao" in conteudo
        assert "401" in conteudo


def test_rotas_nao_exportam_alem_dos_handlers():
    """
    `export const PLANOS` num route.ts quebrou três deploys seguidos: é regra do
    Next.js, não do TypeScript, então a checagem de tipos passa e o build falha.
    """
    permitidos = {
        "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
        "dynamic", "revalidate", "runtime", "preferredRegion", "maxDuration",
        "dynamicParams", "fetchCache", "generateStaticParams",
    }
    api = os.path.join(APP, "api")
    for raiz, _, arquivos in os.walk(api):
        if "route.ts" not in arquivos:
            continue
        conteudo = _ler(raiz, "route.ts")
        for nome in re.findall(r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)",
                               conteudo, re.MULTILINE):
            assert nome in permitidos, \
                f"{os.path.relpath(raiz, RAIZ)}/route.ts exporta '{nome}', que o Next.js recusa"


# ── Honestidade dos números ────────────────────────────────────────

def test_precisao_nao_aparece_sem_amostra():
    """
    100% de acerto sobre três eventos julgados não é um número, é uma amostra.
    Estampá-lo fecha contrato que depois não se sustenta.
    """
    rota = _ler(APP, "api", "console", "relatorios", "route.ts")
    assert "amostra_suficiente" in rota
    tela = _ler(CONSOLE, "relatorios", "page.tsx")
    assert "amostra_suficiente" in tela, "a tela ignora o aviso de amostra pequena"


def test_precisao_sem_julgamento_e_nula_e_nao_zero():
    """
    Zero seria uma afirmação falsa sobre um sistema que simplesmente não foi
    avaliado. `null` significa "ainda não dá para dizer".
    """
    rota = _ler(APP, "api", "console", "relatorios", "route.ts")
    assert re.search(r"julgados > 0 \?.*: null", rota)


def test_painel_mostra_saude_dos_dispositivos():
    """
    Um antifurto que parou de detectar produz uma tela idêntica à de uma loja
    tranquila: zero alertas. Sem a saúde do hardware no painel, o cliente
    descobre que o produto estava mudo quando pedem o vídeo do furto.
    """
    rota = _ler(APP, "api", "console", "resumo", "route.ts")
    assert "hardware_status" in rota and "last_seen" in rota
    assert "sem_deteccao" in rota and "offline" in rota
    tela = _ler(CONSOLE, "page.tsx")
    assert "alertas" in tela


def test_serie_preserva_dias_sem_evento():
    """
    A lacuna é o dado interessante: é como um appliance caído aparece. Um
    filtro aplicado fora da subconsulta descartaria as linhas dos dias vazios
    junto com os eventos.
    """
    for rota in ("resumo", "relatorios"):
        conteudo = _ler(APP, "api", "console", rota, "route.ts")
        assert "generate_series" in conteudo
        assert "LEFT JOIN" in conteudo


# ── Estados da interface ───────────────────────────────────────────

def test_telas_distinguem_carregando_erro_e_vazio():
    """Os três viravam a mesma tela em branco, e ninguém sabia se esperava ou agia."""
    for arquivo, nome in TELAS.items():
        tela = _ler(CONSOLE, *arquivo.split("/"))
        assert "Carregando" in tela, f"{nome} não tem estado de carga"
        assert "Erro" in tela, f"{nome} não tem estado de erro"
        assert "Vazio" in tela, f"{nome} não tem estado vazio"


def test_conta_sem_organizacao_recebe_explicacao():
    """
    Existe de verdade em produção: usuários criados antes da migração
    multi-tenant não pertencem a organização alguma e enxergam zero linhas em
    tudo. Sem esta tela, concluem que o produto está quebrado.
    """
    layout = _ler(CONSOLE, "layout.tsx")
    assert "sem_acesso" in layout
    rota = _ler(APP, "api", "me", "route.ts")
    assert "sem_acesso" in rota


def test_telas_usam_as_primitivas_compartilhadas():
    """Página que reimplementa um botão traz a divergência visual de volta."""
    for arquivo, nome in TELAS.items():
        tela = _ler(CONSOLE, *arquivo.split("/"))
        assert "components/ui'" in tela, f"{nome} não usa o design system"
