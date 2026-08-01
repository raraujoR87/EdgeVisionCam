"""
Retenção e expurgo de dados pessoais.

O appliance grava vídeo de clientes identificáveis dentro de uma loja. Sob a
LGPD isso é tratamento de dado pessoal, e o princípio da necessidade (art. 6º,
III) exige manter apenas pelo tempo do propósito. Sem expurgo automático o
appliance acumula gravações indefinidamente — o que além de ilegal é um risco
concreto, porque um disco cheio de vídeo de clientes é o pior ativo possível
para vazar.

O prazo é configurável porque depende da política do lojista e do tempo que ele
precisa para contestar um evento. O padrão de 30 dias é conservador: cobre o
ciclo de auditoria sem virar arquivo permanente.

Este módulo trata do que é automatizável. A base legal, o aviso na loja e o
contrato com o lojista são decisões que precisam ser tomadas — ver PRIVACIDADE.md.
"""

import os
import time
from typing import Dict

RETENCAO_PADRAO_DIAS = 30

# Abaixo disso, um evento pode ser apagado antes de alguém conseguir revisá-lo.
# Acima, deixa de ser "pelo tempo necessário" sem justificativa registrada.
RETENCAO_MINIMA_DIAS = 1
RETENCAO_MAXIMA_DIAS = 365


def normalizar_dias(valor) -> int:
    """Converte a configuração para um prazo válido, caindo no padrão se inválida."""
    try:
        dias = int(valor)
    except (TypeError, ValueError):
        return RETENCAO_PADRAO_DIAS
    return max(RETENCAO_MINIMA_DIAS, min(RETENCAO_MAXIMA_DIAS, dias))


async def expurgar(queue_db, dias: int, pasta_eventos: str) -> Dict[str, int]:
    """
    Apaga eventos e clipes mais antigos que `dias`.

    Remove o arquivo antes do registro: se o processo morrer no meio, sobra uma
    linha apontando para um clipe inexistente — visível e corrigível — em vez de
    um vídeo órfão no disco que ninguém sabe que existe e que continua sendo
    dado pessoal retido.
    """
    corte = time.time() - (dias * 86400)
    removidos = {"eventos": 0, "clipes": 0, "clipes_ausentes": 0}

    async with queue_db.execute(
        "SELECT id, video_path FROM events WHERE timestamp < ?", (corte,)
    ) as cursor:
        antigos = await cursor.fetchall()

    for linha in antigos:
        caminho = os.path.join(pasta_eventos, os.path.basename(linha["video_path"] or ""))
        if linha["video_path"] and os.path.exists(caminho):
            try:
                os.remove(caminho)
                removidos["clipes"] += 1
            except OSError as erro:
                # Não apaga o registro se o arquivo resistiu: perder o ponteiro
                # deixaria o vídeo retido sem rastro.
                print(f"  [RETENÇÃO] Falha ao remover {caminho}: {erro}")
                continue
        else:
            removidos["clipes_ausentes"] += 1

        await queue_db.execute("DELETE FROM events WHERE id = ?", (linha["id"],))
        removidos["eventos"] += 1

    await queue_db.commit()

    if removidos["eventos"]:
        print(
            f"  [RETENÇÃO] {removidos['eventos']} evento(s) e "
            f"{removidos['clipes']} clipe(s) expurgados (limite: {dias} dias)."
        )
    return removidos


async def expurgar_evento(queue_db, evento_id: int, pasta_eventos: str) -> bool:
    """
    Apaga um evento específico, para atender pedido de eliminação do titular
    (LGPD art. 18, VI).
    """
    async with queue_db.execute(
        "SELECT video_path FROM events WHERE id = ?", (evento_id,)
    ) as cursor:
        linha = await cursor.fetchone()

    if not linha:
        return False

    if linha["video_path"]:
        caminho = os.path.join(pasta_eventos, os.path.basename(linha["video_path"]))
        if os.path.exists(caminho):
            try:
                os.remove(caminho)
            except OSError as erro:
                print(f"  [RETENÇÃO] Falha ao remover {caminho}: {erro}")
                return False

    await queue_db.execute("DELETE FROM events WHERE id = ?", (evento_id,))
    await queue_db.commit()
    print(f"  [RETENÇÃO] Evento {evento_id} eliminado a pedido do titular.")
    return True
