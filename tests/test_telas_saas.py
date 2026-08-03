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


def test_paginas_entram_no_guarda_de_rota():
    """
    O guarda lista as páginas de admin uma a uma. Uma página nova fora da lista
    é alcançável por um STORE_VIEWER que digite a URL — o menu não a mostra,
    mas o menu não é controle de acesso.
    """
    layout = _ler("client-layout.tsx")
    guarda = re.search(r"isTryingToAccessAdminPages\s*=\s*([^\n]+)", layout).group(1)
    for pagina in PAGINAS_DE_ADMIN:
        assert f"/dashboard/{pagina}" in guarda, f"{pagina} fora do guarda de rota"


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
    assert "Consumo" in pagina


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
    for pagina in PAGINAS_DE_ADMIN:
        conteudo = _ler(f"dashboard/{pagina}/page.tsx")
        assert "Authorization" in conteudo and "Bearer" in conteudo, \
            f"{pagina} não envia token"
