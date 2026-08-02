"""
Controle de acesso das rotas de migração de schema.

Elas eram GET sem autenticação nenhuma, executando ALTER TABLE e reescrevendo a
coluna `role` dos usuários. Num SaaS multi-tenant isso é indisponibilidade geral
(ALTER TABLE toma lock) e, no caso do RBAC, alteração de quem é SUPER_ADMIN.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROTAS = [
    "ui/app/api/migrate/route.ts",
    "ui/app/api/migrate-rbac/route.ts",
]


def _fonte(caminho):
    with open(os.path.join(RAIZ, caminho), encoding="utf-8") as arquivo:
        return arquivo.read()


def test_rotas_de_migracao_exigem_autorizacao():
    for rota in ROTAS:
        conteudo = _fonte(rota)
        assert "autorizarMigracao" in conteudo, f"{rota} não verifica autorização"
        # A checagem tem de vir ANTES de qualquer query: autorizar depois de já
        # ter alterado o schema não protege nada.
        pos_check = conteudo.index("autorizarMigracao(request)")
        pos_query = conteudo.index("await query(")
        assert pos_check < pos_query, f"{rota} consulta o banco antes de autorizar"


def test_falha_fechada_sem_segredo_configurado():
    """
    Sem MIGRATION_SECRET a rota não pode abrir nem para o bootstrap. Um valor
    padrão faria todo deploy novo aceitar migração de qualquer origem.
    """
    conteudo = _fonte("ui/app/api/migrations.ts")
    assert "process.env.MIGRATION_SECRET" in conteudo
    assert re.search(r"if\s*\(!esperado\)", conteudo), "sem tratamento de segredo ausente"
    # Não pode haver fallback literal.
    assert not re.search(r"MIGRATION_SECRET\s*\|\|\s*['\"][^'\"]+['\"]", conteudo), \
        "há um valor padrão para MIGRATION_SECRET"


def test_comparacao_de_segredo_em_tempo_constante():
    """
    Um `===` sobre segredos vaza o comprimento do prefixo correto pelo tempo de
    resposta. Endpoint público e sem limite de tentativas torna isso explorável.
    """
    conteudo = _fonte("ui/app/api/migrations.ts")
    assert "iguaisEmTempoConstante" in conteudo
    assert "charCodeAt" in conteudo and "^" in conteudo


def test_token_precisa_de_papel_administrativo():
    conteudo = _fonte("ui/app/api/migrations.ts")
    assert "SUPER_ADMIN" in conteudo
    assert "verifyToken" in conteudo
