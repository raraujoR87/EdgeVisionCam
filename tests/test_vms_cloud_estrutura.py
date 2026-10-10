"""
VMS Cloud — invariantes de estrutura, lidas do código.

O que o banco não cobre: quem pode usar a conexão de serviço (que ignora RLS),
quais rotas exigem sessão, e o que o Next.js aceita exportar de um route.ts.
Cada um destes já causou incidente ou deploy quebrado em projetos anteriores.
"""

import os
import re

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(RAIZ, "vms-cloud", "app")
LIB = os.path.join(RAIZ, "vms-cloud", "lib")
API = os.path.join(APP, "api")


def _rotas():
    for raiz, _, arquivos in os.walk(API):
        if "route.ts" in arquivos:
            caminho = os.path.join(raiz, "route.ts")
            with open(caminho, encoding="utf-8") as f:
                yield os.path.relpath(caminho, API), f.read()


# Rotas que NÃO são de usuário logado. A lista é curta de propósito: cada entrada
# precisa de justificativa, e adicionar uma deve ser uma decisão visível em revisão.
ROTAS_PUBLICAS = {
    "auth/login/route.ts": "login: acontece antes de existir identidade",
    "convites/aceitar/route.ts": "aceite de convite: quem aceita ainda não tem sessão; tem token de uso único",
    "ingestao/eventos/route.ts": "ingestão: autentica pela chave do agente, não por sessão de usuário",
}

# Só estes arquivos podem falar com a conexão de serviço diretamente. Ela ignora
# RLS, então cada uso fora desta lista é um vazamento esperando acontecer.
USO_DE_SERVICO_PERMITIDO = {
    "auth/login/route.ts",  # lê users para checar a senha, antes de existir identidade
}


def test_exports_de_route_sao_so_handlers_e_config():
    """
    `export const PLANOS` num route.ts quebrou três deploys seguidos: é regra do
    Next.js, não do TypeScript, então a checagem de tipos passa e o build falha.
    """
    permitidos = {
        "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
        "dynamic", "revalidate", "runtime", "preferredRegion", "maxDuration",
        "dynamicParams", "fetchCache", "generateStaticParams",
    }
    for rota, conteudo in _rotas():
        for nome in re.findall(r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)",
                               conteudo, re.MULTILINE):
            assert nome in permitidos, f"{rota} exporta '{nome}', que o Next.js recusa"


def test_toda_rota_de_usuario_exige_sessao():
    for rota, conteudo in _rotas():
        if rota in ROTAS_PUBLICAS:
            continue
        assert "sessaoDaRequisicao" in conteudo, f"{rota} não verifica sessão"
        assert "401" in conteudo, f"{rota} não responde 401 sem sessão"


def test_rotas_publicas_estao_justificadas_e_existem():
    existentes = {rota for rota, _ in _rotas()}
    for rota, motivo in ROTAS_PUBLICAS.items():
        assert rota in existentes, f"{rota} listada como pública mas não existe"
        assert motivo.strip(), f"{rota} sem justificativa"


def test_conexao_de_servico_so_nas_rotas_permitidas():
    """
    Consulta de usuário passa por comUsuario (RLS ativa). A conexão de serviço
    é exceção, e a lista de exceções é visível.
    """
    for rota, conteudo in _rotas():
        usa_servico = "obterPool" in conteudo or "comServico" in conteudo
        if usa_servico:
            assert rota in USO_DE_SERVICO_PERMITIDO, \
                f"{rota} usa conexão de serviço (ignora RLS) sem estar na lista permitida"


def test_biblioteca_nao_consulta_com_servico_fora_de_ingestao_e_convite():
    """
    Dentro de lib/, só os caminhos de serviço declarados podem ignorar RLS.
    Cada um tem o inquilino vindo de credencial verificada, não do corpo.
    """
    permitidos = {"ingestao.ts", "convites.ts", "tenant.ts", "auth.ts", "db.ts"}
    for raiz, _, arquivos in os.walk(LIB):
        for arq in arquivos:
            if not arq.endswith(".ts") or arq.endswith(".test.ts"):
                continue
            with open(os.path.join(raiz, arq), encoding="utf-8") as f:
                conteudo = f.read()
            if "comServico(" in conteudo or "obterPool()" in conteudo:
                assert arq in permitidos, f"lib/{arq} usa conexão de serviço fora dos caminhos previstos"


def test_frame_nao_e_gravado_em_lugar_nenhum():
    """
    O frame chega, vai para o modelo e some. Nenhuma função de persistência
    recebe o JPEG. A checagem é textual e deliberadamente conservadora.
    """
    ingestao = os.path.join(LIB, "ingestao.ts")
    with open(ingestao, encoding="utf-8") as f:
        conteudo = f.read()
    # Só o analisador recebe o JPEG. Qualquer SQL com a imagem seria um vazamento.
    trechos_sql = re.findall(r"`[^`]*(?:INSERT|UPDATE)[^`]*`", conteudo, re.DOTALL)
    for trecho in trechos_sql:
        assert "jpegBase64" not in trecho, "imagem aparece em SQL de ingestão"
        assert "imagem" not in trecho.lower(), "imagem aparece em SQL de ingestão"


def test_telas_nao_usam_a_chave_de_sessao_antiga():
    """A chave de sessão deste projeto é vms_token; a de outro projeto não pode vazar para cá."""
    for raiz, _, arquivos in os.walk(os.path.join(RAIZ, "vms-cloud", "app")):
        for arq in arquivos:
            if arq.endswith(".tsx"):
                with open(os.path.join(raiz, arq), encoding="utf-8") as f:
                    assert "admin_token" not in f.read(), f"{arq} usa admin_token"


def test_convite_nao_e_listado_nem_reenviado():
    """O token de convite só existe na resposta da criação. Nunca na listagem."""
    with open(os.path.join(API, "convites", "route.ts"), encoding="utf-8") as f:
        conteudo = f.read()
    listagem = conteudo.split("export async function GET")[1].split("export async function POST")[0]
    assert "token" not in listagem.lower(), "a listagem de convites expõe token"
