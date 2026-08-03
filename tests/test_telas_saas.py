"""
Telas do painel multi-tenant.

Tela sem link é tela que não existe, e página fora do guarda de rota é página
que um VIEWER alcança digitando a URL. Estes testes travam as duas coisas.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(RAIZ, "ui", "app")


def _ler(caminho):
    with open(os.path.join(APP, caminho), encoding="utf-8") as arquivo:
        return arquivo.read()


PAGINAS_DE_ADMIN = ["organizations", "audit"]


def test_paginas_existem():
    for pagina in PAGINAS_DE_ADMIN:
        assert os.path.isfile(os.path.join(APP, "dashboard", pagina, "page.tsx")), \
            f"dashboard/{pagina}/page.tsx não existe"


def test_paginas_estao_na_navegacao():
    """Sem link no menu, a tela só é alcançável por quem souber a URL."""
    layout = _ler("client-layout.tsx")
    for pagina in PAGINAS_DE_ADMIN:
        assert f'href="/dashboard/{pagina}"' in layout, f"{pagina} não está no menu"


def test_guarda_de_rota_nega_por_padrao():
    """
    O guarda enumerava os caminhos proibidos ao cliente, um a um. O modo de
    falha era abrir demais: bastava alguém criar uma tela de fornecedor e
    esquecer de acrescentá-la à lista para ela ficar alcançável por quem
    digitasse a URL.

    A regra agora é a inversa — quem não é fornecedor vive em /console, e
    qualquer outro caminho o traz de volta. Uma tela nova nasce fora do alcance
    dele sem ninguém precisar lembrar de nada.

    Este teste trava a inversão: se a lista voltar, ele quebra.
    """
    layout = _ler("client-layout.tsx")
    assert "isTryingToAccessAdminPages" not in layout, \
        "o guarda voltou a enumerar caminhos proibidos"
    assert re.search(r"!ehFornecedor && !isConsolePage", layout), \
        "o guarda deixou de mandar o cliente para /console"
    assert "window.location.href = '/console'" in layout


def test_auditoria_nao_oferece_como_apagar():
    """
    Trilha que a interface consegue alterar não serve como trilha. A ausência
    do botão é parte do desenho, não esquecimento.
    """
    pagina = _ler("dashboard/audit/page.tsx")
    assert "method: 'DELETE'" not in pagina
    assert "method: 'POST'" not in pagina


def test_clientes_mostra_consumo_contra_o_limite():
    """
    Um cliente que atingiu o teto do plano não consegue crescer e ninguém
    percebe — é conversa comercial que precisa acontecer antes do churn.
    """
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "max_stores" in pagina and "max_appliances" in pagina
    # O medidor mora nas primitivas; a tela consome.
    assert "Medidor" in pagina


def test_clientes_sinaliza_appliance_parado():
    """
    Appliance instalado e zero eventos em 24h significa cliente pagando por
    algo que parou. É o sinal mais acionável da tela.
    """
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "eventos_24h" in pagina
    assert re.search(r"appliance_count > 0 && \w+\.eventos_24h === 0", pagina)


def test_suspender_nao_e_excluir():
    """Inadimplência não pode destruir os dados do cliente."""
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "'suspensa'" in pagina
    assert "method: 'DELETE'" not in pagina


def test_telas_enviam_token():
    """
    Aceita as duas formas: o cabeçalho montado na página, ou os helpers
    compartilhados que já o incluem. O que não pode é a requisição sair sem
    credencial — e como a RLS depende do token para saber quem pergunta, uma
    chamada sem ele volta vazia, não com erro.
    """
    with open(PRIMITIVAS, encoding="utf-8") as f:
        primitivas = f.read()
    assert "Authorization" in primitivas and "Bearer" in primitivas

    for pagina in PAGINAS_DE_ADMIN:
        conteudo = _ler(f"dashboard/{pagina}/page.tsx")
        usa_helper = "buscar" in conteudo or "enviar" in conteudo
        monta_direto = "Authorization" in conteudo and "Bearer" in conteudo
        assert usa_helper or monta_direto, f"{pagina} pode requisitar sem token"


# ── Design system ──────────────────────────────────────────────────

PRIMITIVAS = os.path.join(RAIZ, "ui", "components", "ui", "index.tsx")


def test_primitivas_compartilhadas_existem():
    """
    Não havia componente compartilhado nenhum: cada página reinventava botão,
    campo e estado vazio. O resultado agregado parecia feito por pessoas
    diferentes — porque foi. Não era falta de capricho numa tela, era ausência
    de sistema, e cada tela nova aumentava a divergência.
    """
    assert os.path.isfile(PRIMITIVAS)
    with open(PRIMITIVAS, encoding="utf-8") as f:
        conteudo = f.read()
    for componente in ("Botao", "Campo", "Cartao", "Vazio", "Erro", "Carregando", "Paginacao"):
        assert f"export function {componente}" in conteudo, f"falta {componente}"


def test_telas_usam_as_primitivas():
    """Página que reimplementa um botão traz a divergência de volta."""
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "from '../../../components/ui'" in pagina
    for componente in ("Botao", "Cartao", "Vazio", "Erro", "Carregando"):
        assert componente in pagina


def test_estados_de_carga_erro_e_vazio_sao_distintos():
    """
    Os três viravam a mesma tela em branco, e o usuário não sabia se esperava
    ou agia.
    """
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "isLoading &&" in pagina
    assert "error &&" in pagina
    assert re.search(r"orgs\.length === 0", pagina)
    # Busca sem resultado é um quarto estado, e diz outra coisa.
    assert re.search(r"filtradas\.length === 0", pagina)


def test_listagem_tem_busca_e_paginacao():
    """
    Trazer tudo sempre não é problema com uma loja. É o defeito que aparece
    exatamente quando o negócio começa a dar certo.
    """
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "Paginacao" in pagina and "POR_PAGINA" in pagina
    assert "Busca" in pagina


def test_erro_da_api_nao_e_renderizado_como_lista():
    """
    O fetcher devolvia `{error: "..."}` no `data`, e a tela tentava iterar
    aquilo. Agora vira exceção e cai no ramo de erro.
    """
    with open(PRIMITIVAS, encoding="utf-8") as f:
        conteudo = f.read()
    assert "if (!r.ok) throw new Error" in conteudo


def test_troca_de_plano_e_otimista():
    """
    Sem retorno imediato, trocar o plano parecia que o clique não funcionou.
    A lista atualiza na hora e revalida em seguida.
    """
    pagina = _ler("dashboard/organizations/page.tsx")
    assert "revalidate: false" in pagina
