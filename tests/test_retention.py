"""
Testes do expurgo de dados pessoais.

O appliance grava vídeo de clientes identificáveis. Sem expurgo automático ele
acumula gravações indefinidamente, o que contraria o princípio da necessidade
da LGPD e transforma o disco no pior ativo possível para vazar.
"""

import os
import sys
import time

import pytest
import pytest_asyncio

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core import retention  # noqa: E402


# ── Normalização do prazo ──────────────────────────────────────────

def test_prazo_padrao_para_valor_ausente():
    assert retention.normalizar_dias(None) == retention.RETENCAO_PADRAO_DIAS


@pytest.mark.parametrize("entrada", ["lixo", "", "30 dias", [], {}])
def test_prazo_padrao_para_valor_invalido(entrada):
    """Config corrompida não pode virar retenção infinita nem expurgo imediato."""
    assert retention.normalizar_dias(entrada) == retention.RETENCAO_PADRAO_DIAS


def test_prazo_aceita_valor_valido():
    assert retention.normalizar_dias("7") == 7
    assert retention.normalizar_dias(90) == 90


def test_prazo_e_limitado_nos_extremos():
    """Zero apagaria o evento antes de alguém revisar; anos deixaria de ser
    'pelo tempo necessário'."""
    assert retention.normalizar_dias(0) == retention.RETENCAO_MINIMA_DIAS
    assert retention.normalizar_dias(-5) == retention.RETENCAO_MINIMA_DIAS
    assert retention.normalizar_dias(99999) == retention.RETENCAO_MAXIMA_DIAS


# ── Expurgo ────────────────────────────────────────────────────────

@pytest_asyncio.fixture()
async def banco_com_eventos(tmp_path):
    """queue.db com um evento antigo e um recente, e os clipes no disco."""
    import aiosqlite

    pasta = tmp_path / "events"
    pasta.mkdir()

    db = await aiosqlite.connect(str(tmp_path / "queue.db"))
    db.row_factory = aiosqlite.Row
    await db.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp REAL, "
        "status TEXT, video_path TEXT, ai_verdict BOOLEAN, payload_json TEXT, "
        "suspicion_score REAL)"
    )

    agora = time.time()
    for ident, idade_dias, nome in [(1, 45, "antigo.mp4"), (2, 2, "recente.mp4")]:
        (pasta / nome).write_bytes(b"video")
        await db.execute(
            "INSERT INTO events (id, timestamp, status, video_path) VALUES (?,?,?,?)",
            (ident, agora - idade_dias * 86400, "CLEARED", nome),
        )
    await db.commit()

    yield db, str(pasta)
    await db.close()


@pytest.mark.asyncio
async def test_expurga_apenas_o_que_venceu(banco_com_eventos):
    db, pasta = banco_com_eventos

    resultado = await retention.expurgar(db, dias=30, pasta_eventos=pasta)

    assert resultado["eventos"] == 1
    assert resultado["clipes"] == 1
    assert not os.path.exists(os.path.join(pasta, "antigo.mp4"))
    assert os.path.exists(os.path.join(pasta, "recente.mp4"))

    async with db.execute("SELECT id FROM events") as cur:
        restantes = [l["id"] for l in await cur.fetchall()]
    assert restantes == [2]


@pytest.mark.asyncio
async def test_expurgo_sem_nada_vencido_nao_altera_nada(banco_com_eventos):
    db, pasta = banco_com_eventos

    resultado = await retention.expurgar(db, dias=365, pasta_eventos=pasta)

    assert resultado["eventos"] == 0
    async with db.execute("SELECT COUNT(*) c FROM events") as cur:
        assert (await cur.fetchone())["c"] == 2


@pytest.mark.asyncio
async def test_registro_e_removido_mesmo_sem_o_clipe(banco_com_eventos):
    """Clipe já apagado à mão não pode deixar o registro preso para sempre."""
    db, pasta = banco_com_eventos
    os.remove(os.path.join(pasta, "antigo.mp4"))

    resultado = await retention.expurgar(db, dias=30, pasta_eventos=pasta)

    assert resultado["eventos"] == 1
    assert resultado["clipes_ausentes"] == 1


@pytest.mark.asyncio
async def test_expurgo_ignora_caminho_com_diretorio(banco_com_eventos):
    """
    video_path vem do banco; um valor com diretórios não pode fazer o expurgo
    apagar arquivo fora da pasta de eventos.
    """
    db, pasta = banco_com_eventos
    await db.execute(
        "UPDATE events SET video_path = '../../../etc/passwd' WHERE id = 1"
    )
    await db.commit()

    await retention.expurgar(db, dias=30, pasta_eventos=pasta)

    assert os.path.exists("/etc/passwd")


# ── Direito de eliminação ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_elimina_evento_especifico(banco_com_eventos):
    db, pasta = banco_com_eventos

    assert await retention.expurgar_evento(db, 2, pasta) is True
    assert not os.path.exists(os.path.join(pasta, "recente.mp4"))

    async with db.execute("SELECT id FROM events") as cur:
        assert [l["id"] for l in await cur.fetchall()] == [1]


@pytest.mark.asyncio
async def test_eliminar_evento_inexistente(banco_com_eventos):
    db, pasta = banco_com_eventos
    assert await retention.expurgar_evento(db, 999, pasta) is False
