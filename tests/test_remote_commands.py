"""
Comandos remotos: o que o appliance aceita executar, e o que ele recusa.

O canal parte de fora da loja e termina num processo com acesso ao Docker do
host. É o caminho mais curto entre "alguém entrou no painel" e "alguém está
dentro do appliance", então o que os testes travam aqui não é o caminho feliz —
é o tamanho do conjunto de coisas que a nuvem consegue mandar fazer.
"""

import json
import os
import re
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge import remote_commands as rc  # noqa: E402

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API = os.path.join(RAIZ, "ui", "app", "api")


def _ler(caminho):
    with open(os.path.join(API, caminho), encoding="utf-8") as arquivo:
        return arquivo.read()


# ── A lista fechada ────────────────────────────────────────────────

def test_comando_fora_da_lista_e_recusado():
    status, resultado = rc.executar("rm -rf /")
    assert status == "FALHOU"
    assert "não reconhecido" in resultado["erro"]


@pytest.mark.parametrize(
    "comando",
    ["exec", "shell", "atualizar", "docker", "", None, "reiniciar_engine "],
)
def test_variacoes_proximas_nao_passam(comando):
    """
    Nomes que um atacante tentaria por serem plausíveis, mais o caso do espaço
    à direita — um `strip()` esquecido na nuvem não deve virar execução aqui.
    """
    status, _ = rc.executar(comando)
    assert status == "FALHOU"


def test_a_nuvem_nao_consegue_nomear_um_container(monkeypatch):
    """
    O parâmetro é apelido de serviço, nunca nome de container. Se a tradução
    acontecesse na nuvem, um comando forjado alcançaria qualquer container do
    host — inclusive os que não são deste produto.
    """
    chamados = []
    monkeypatch.setattr(rc.docker_client, "ler_logs", lambda nome, linhas: chamados.append(nome) or "")

    status, resultado = rc.executar("coletar_logs", {"servico": "visioncam-docker-proxy"})

    assert status == "FALHOU"
    assert "fora da lista" in resultado["erro"]
    assert chamados == [], "o nome forjado chegou ao Docker"


@pytest.mark.parametrize(
    "servico",
    ["../../etc", "visioncam-core", "engine; rm -rf /", "ENGINE", "portainer_agent"],
)
def test_servico_forjado_nao_vira_requisicao(monkeypatch, servico):
    monkeypatch.setattr(
        rc.docker_client, "ler_logs",
        lambda *a, **k: pytest.fail("requisição feita com serviço inválido"),
    )
    status, _ = rc.executar("coletar_logs", {"servico": servico})
    assert status == "FALHOU"


def test_todo_servico_mapeia_para_container_do_produto():
    """
    A lista de containers visíveis pela API interna já é a fronteira usada pelo
    endpoint de logs. Divergir dela aqui abriria uma segunda porta, mais larga,
    sem ninguém perceber.
    """
    from core.api_internal.main import CONTAINERS_VISIVEIS

    for container in rc.SERVICOS.values():
        assert container in CONTAINERS_VISIVEIS, f"{container} fora da lista da API"


# ── Parâmetros ─────────────────────────────────────────────────────

@pytest.mark.parametrize("linhas", [0, -1, 5000, "muitas", None, 1.5])
def test_linhas_invalidas_sao_recusadas(monkeypatch, linhas):
    monkeypatch.setattr(
        rc.docker_client, "ler_logs",
        lambda *a, **k: pytest.fail("requisição feita com linhas inválido"),
    )
    status, _ = rc.executar("coletar_logs", {"servico": "engine", "linhas": linhas})
    assert status == "FALHOU"


def test_logs_usam_o_limite_pedido(monkeypatch):
    recebido = {}

    def falso(nome, linhas):
        recebido["nome"], recebido["linhas"] = nome, linhas
        return "linha de log"

    monkeypatch.setattr(rc.docker_client, "ler_logs", falso)

    status, resultado = rc.executar("coletar_logs", {"servico": "frigate", "linhas": 20})

    assert status == "CONCLUIDO"
    assert recebido == {"nome": "visioncam-frigate", "linhas": 20}
    assert resultado["logs"] == "linha de log"


# ── Execução ───────────────────────────────────────────────────────

def test_restart_reporta_o_container_que_tocou(monkeypatch):
    tocados = []
    monkeypatch.setattr(
        rc.docker_client, "reiniciar_container",
        lambda nome: tocados.append(nome) or True,
    )

    status, resultado = rc.executar("reiniciar_frigate")

    assert status == "CONCLUIDO"
    assert tocados == ["visioncam-frigate"]
    assert resultado["container"] == "visioncam-frigate"


def test_restart_recusado_pelo_docker_vira_falha_reportavel(monkeypatch):
    """
    O appliance precisa dizer que não conseguiu. Silêncio aqui deixaria o
    console exibindo "executando" para sempre, e alguém pegaria o carro.
    """
    monkeypatch.setattr(rc.docker_client, "reiniciar_container", lambda nome: False)

    status, resultado = rc.executar("reiniciar_engine")

    assert status == "FALHOU"
    assert "visioncam-core" in resultado["erro"]


def test_excecao_inesperada_nao_escapa(monkeypatch):
    """
    `executar` não levanta: uma exceção subindo até o loop de poll mataria a
    tarefa, e o appliance sumiria do painel por causa de um comando ruim.
    """
    def explode(*a, **k):
        raise ValueError("algo muito errado")

    monkeypatch.setattr(rc.docker_client, "reiniciar_container", explode)

    status, resultado = rc.executar("reiniciar_engine")

    assert status == "FALHOU"
    assert "ValueError" in resultado["erro"]


# ── Rodada de poll ─────────────────────────────────────────────────

def test_rodada_sem_configuracao_nao_vai_a_rede(monkeypatch):
    monkeypatch.setattr(
        rc.urllib.request, "urlopen",
        lambda *a, **k: pytest.fail("não deveria abrir conexão"),
    )
    assert rc.processar_rodada("", "chave") == 0
    assert rc.processar_rodada("https://nuvem", "") == 0


def test_rodada_executa_e_reporta(monkeypatch):
    enviados = []

    def falso_requisitar(url, api_key, corpo=None):
        if corpo is None:
            return {"comandos": [{"id": 7, "comando": "reiniciar_engine", "parametros": {}}]}
        enviados.append(corpo)
        return {"status": "success"}

    monkeypatch.setattr(rc, "_requisitar", falso_requisitar)
    monkeypatch.setattr(rc.docker_client, "reiniciar_container", lambda nome: True)

    assert rc.processar_rodada("https://nuvem", "chave", log=lambda *a: None) == 1
    assert enviados == [{"id": 7, "status": "CONCLUIDO", "resultado": {"container": "visioncam-core", "acao": "restart"}}]


def test_comando_desconhecido_e_reportado_como_falha(monkeypatch):
    """
    O appliance responde em vez de ignorar. Sem isso o comando ficaria
    ENTREGUE até a varredura da nuvem, e o operador não saberia que a placa
    está numa versão que não conhece aquele comando.
    """
    enviados = []

    def falso_requisitar(url, api_key, corpo=None):
        if corpo is None:
            return {"comandos": [{"id": 9, "comando": "formatar_tudo", "parametros": {}}]}
        enviados.append(corpo)
        return {"status": "success"}

    monkeypatch.setattr(rc, "_requisitar", falso_requisitar)

    rc.processar_rodada("https://nuvem", "chave", log=lambda *a: None)

    assert enviados[0]["status"] == "FALHOU"


def test_falha_de_rede_na_busca_nao_derruba_o_loop(monkeypatch):
    def falha(*a, **k):
        raise urllib.error.URLError("rede da loja caiu")

    monkeypatch.setattr(rc, "_requisitar", falha)
    assert rc.processar_rodada("https://nuvem", "chave", log=lambda *a: None) == 0


def test_relatorio_perdido_nao_reexecuta(monkeypatch):
    """
    Reportar é o passo que pode falhar depois de o comando já ter rodado.
    Repetir a execução tiraria a loja do ar de novo — a rodada aceita a perda
    e segue.
    """
    reinicios = []

    def falso_requisitar(url, api_key, corpo=None):
        if corpo is None:
            return {"comandos": [{"id": 3, "comando": "reiniciar_engine", "parametros": {}}]}
        raise urllib.error.URLError("caiu na hora de reportar")

    monkeypatch.setattr(rc, "_requisitar", falso_requisitar)
    monkeypatch.setattr(
        rc.docker_client, "reiniciar_container",
        lambda nome: reinicios.append(nome) or True,
    )

    assert rc.processar_rodada("https://nuvem", "chave", log=lambda *a: None) == 1
    assert reinicios == ["visioncam-core"], "o comando executou mais de uma vez"


# ── As duas listas precisam bater ──────────────────────────────────

def test_catalogo_da_nuvem_e_o_do_appliance_coincidem():
    """
    A nuvem oferece botões; o appliance decide o que executa. Um comando só na
    nuvem vira um botão que sempre falha; um só no appliance é poder que
    ninguém revisou na tela. Divergir é sempre defeito.
    """
    conteudo = _ler("comandos.ts")
    da_nuvem = set(re.findall(r"^  (\w+): \{$", conteudo, re.MULTILINE))
    assert da_nuvem == set(rc.COMANDOS), (
        f"só na nuvem: {da_nuvem - set(rc.COMANDOS)}; "
        f"só no appliance: {set(rc.COMANDOS) - da_nuvem}"
    )


def test_servicos_coincidem_entre_nuvem_e_appliance():
    conteudo = _ler("comandos.ts")
    linha = re.search(r"export const SERVICOS = \[(.*?)\]", conteudo, re.DOTALL).group(1)
    da_nuvem = set(re.findall(r"'(\w+)'", linha))
    assert da_nuvem == set(rc.SERVICOS)


def test_teto_de_linhas_coincide():
    """Um teto maior na nuvem produziria um comando aceito lá e recusado aqui."""
    conteudo = _ler("comandos.ts")
    valor = re.search(r"MAX_LINHAS_LOG = (\d+)", conteudo).group(1)
    assert int(valor) == rc.MAX_LINHAS_LOG


# ── Propriedades das rotas da nuvem ────────────────────────────────

def test_rota_de_comando_exige_papel_de_administrador():
    conteudo = _ler("commands/route.ts")
    assert "podeAdministrar" in conteudo, "a rota não checa papel"
    # A checagem centralizada existe justamente para não ser reescrita à mão em
    # cada rota — ver ui/app/api/papeis.ts.
    assert "'SUPER_ADMIN'" not in conteudo, "papel comparado à mão, fora de papeis.ts"


def test_emissao_de_comando_deixa_rastro():
    """
    "Quem mandou reiniciar a loja 12 às 3h da manhã?" precisa ter resposta, e
    o registro tem de estar na mesma transação da inserção.
    """
    conteudo = _ler("commands/route.ts")
    corpo = re.search(
        r"export async function POST\(request: Request\)[\s\S]*?(?=\nexport async function |\Z)",
        conteudo,
    ).group(0)
    assert "registrarAuditoria" in corpo
    assert "comInquilino" in corpo


def test_rota_de_comando_nao_consulta_fora_do_envelope():
    """`query()` direto ignora a RLS — seria comandar appliance de outro cliente."""
    conteudo = _ler("commands/route.ts")
    assert not re.search(r"\bawait query\(", conteudo)
    assert "comInquilino" in conteudo


def test_rota_do_appliance_nao_aceita_a_chave_da_loja():
    """
    A `api_key` da loja é compartilhada entre appliances. Aceitá-la aqui faria
    um appliance consumir o comando destinado a outro — e uma chave de loja
    vazada comandaria a loja inteira.
    """
    conteudo = _ler("edge/commands/route.ts")
    assert "edge_key" in conteudo
    assert "FROM stores WHERE api_key" not in conteudo
    assert "api_key = $1" not in conteudo


def test_appliance_revogado_nao_recebe_comando():
    conteudo = _ler("edge/commands/route.ts")
    assert "status !== 'ATIVO'" in conteudo


def test_entrega_e_leitura_acontecem_no_mesmo_update():
    """
    Ler e depois marcar abriria a janela em que dois polls levam o mesmo
    comando — e um restart repetido tira a loja do ar sem ninguém ter pedido.
    """
    conteudo = _ler("edge/commands/route.ts")
    assert "RETURNING id, comando, parametros" in conteudo
    assert "SKIP LOCKED" in conteudo


def test_appliance_so_escreve_no_proprio_comando():
    conteudo = _ler("edge/commands/route.ts")
    corpo = re.search(
        r"export async function POST\(request: Request\)[\s\S]*", conteudo
    ).group(0)
    assert "appliance_id = $4" in corpo, "o UPDATE não amarra o comando ao appliance"
    assert "status = 'ENTREGUE'" in corpo, "aceita resultado de comando não entregue"


def test_comando_pendente_vence_sozinho():
    """
    Sem vencimento, um comando enfileirado durante uma queda de link executaria
    horas depois, quando o operador já tomou outra decisão.
    """
    migracao = _ler("migrate/route.ts")
    assert "expires_at" in migracao and "INTERVAL '15 minutes'" in migracao

    rota = _ler("edge/commands/route.ts")
    assert "'EXPIRADO'" in rota
    assert "expires_at > NOW()" in rota, "comando vencido ainda seria entregue"


def test_fila_tem_isolamento_no_banco():
    """
    A fila diz qual loja foi reiniciada e quando. É dado de cliente, e segue a
    mesma regra das outras tabelas.

    A política precisa existir nos dois caminhos que criam schema: o arquivo
    SQL (aplicado à mão, e o que tests/integracao/ exercita contra um Postgres
    de verdade) e a rota de migração (o único que roda sozinho num deploy).
    Um banco que recebeu só um dos dois teria a tabela sem o isolamento.
    """
    for conteudo in (_ler("migrate/route.ts"),
                     open(os.path.join(RAIZ, "shared", "schema_multitenant.sql"),
                          encoding="utf-8").read()):
        assert "command_isolamento" in conteudo
        assert "app_orgs_permitidas()" in conteudo
        assert "ENABLE ROW LEVEL SECURITY" in conteudo


def test_tabela_da_fila_existe_nos_dois_caminhos_de_schema():
    """
    `appliances` já vive em shared/schema.sql e na rota de migração — a fila
    segue o mesmo par. Divergir deixaria a rota de comandos com 500 num
    ambiente e funcionando no outro.
    """
    for conteudo in (_ler("migrate/route.ts"),
                     open(os.path.join(RAIZ, "shared", "schema.sql"),
                          encoding="utf-8").read()):
        assert "CREATE TABLE IF NOT EXISTS appliance_commands" in conteudo
        assert "idx_commands_fila" in conteudo
