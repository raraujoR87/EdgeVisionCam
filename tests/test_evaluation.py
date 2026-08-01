"""
Testes das métricas de acurácia.

Num sistema de prevenção de perdas os dois erros têm custos diferentes — um
furto perdido custa o item, um alerta sobre inocente custa o cliente. Estes
testes travam essa distinção para que ela não se dissolva numa "acurácia" única.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from evaluation.metrics import avaliar, e_alerta, formatar_relatorio  # noqa: E402


# ── Classificação de veredicto ─────────────────────────────────────

@pytest.mark.parametrize("veredicto", ["THEFT_CONFIRMED", "FURTO_CONFIRMADO", "SUSPEITO"])
def test_veredictos_que_geram_alerta(veredicto):
    assert e_alerta(veredicto)


@pytest.mark.parametrize("veredicto", ["CLEARED", "INOCENTADO", "PENDING"])
def test_veredictos_que_nao_geram_alerta(veredicto):
    assert not e_alerta(veredicto)


def test_suspeito_conta_como_alerta():
    """
    SUSPEITO mobiliza alguém a abordar o cliente, então sobre um inocente
    carrega o mesmo custo de um falso positivo declarado.
    """
    r = avaliar([{"verdadeiro": False, "veredicto": "SUSPEITO"}])
    assert r.falso_positivo == 1


def test_veredicto_e_insensivel_a_caixa_e_espaco():
    assert e_alerta("  furto_confirmado  ")


# ── Matriz de confusão ─────────────────────────────────────────────

def test_matriz_de_confusao_completa():
    pares = [
        {"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"},   # VP
        {"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"},   # VP
        {"verdadeiro": False, "veredicto": "FURTO_CONFIRMADO"}, # FP
        {"verdadeiro": True, "veredicto": "CLEARED"},           # FN
        {"verdadeiro": False, "veredicto": "INOCENTADO"},       # VN
    ]
    r = avaliar(pares)

    assert (r.verdadeiro_positivo, r.falso_positivo,
            r.falso_negativo, r.verdadeiro_negativo) == (2, 1, 1, 1)
    assert r.total == 5


def test_precisao_e_revocacao():
    pares = [
        {"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"},
        {"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"},
        {"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"},
        {"verdadeiro": False, "veredicto": "THEFT_CONFIRMED"},  # 1 falso positivo
        {"verdadeiro": True, "veredicto": "CLEARED"},           # 1 furto perdido
    ]
    r = avaliar(pares)

    assert r.precisao == pytest.approx(3 / 4)   # 3 de 4 alertas eram furto
    assert r.revocacao == pytest.approx(3 / 4)  # 3 de 4 furtos pegos
    assert r.f1 == pytest.approx(0.75)


def test_taxa_de_falso_alarme():
    pares = [{"verdadeiro": False, "veredicto": "SUSPEITO"}] + [
        {"verdadeiro": False, "veredicto": "INOCENTADO"} for _ in range(9)
    ]
    assert avaliar(pares).taxa_falso_alarme == pytest.approx(0.1)


def test_metricas_sem_denominador_retornam_nulo():
    """Sem alertas emitidos não existe precisão — e reportar 0% ou 100%
    seria inventar informação."""
    r = avaliar([{"verdadeiro": False, "veredicto": "CLEARED"}])
    assert r.precisao is None
    assert r.revocacao is None
    assert r.f1 is None


def test_amostra_vazia():
    r = avaliar([])
    assert r.total == 0
    assert r.precisao is None


# ── Rastreabilidade dos erros ──────────────────────────────────────

def test_erros_preservam_identificacao_do_clipe():
    """O relatório precisa apontar qual clipe revisar, não só quantos erraram."""
    r = avaliar([
        {"verdadeiro": False, "veredicto": "THEFT_CONFIRMED", "id": 42, "clipe": "a.mp4"},
        {"verdadeiro": True, "veredicto": "CLEARED", "id": 43, "clipe": "b.mp4"},
    ])

    tipos = {e["tipo_erro"]: e for e in r.erros}
    assert tipos["FALSO_POSITIVO"]["id"] == 42
    assert tipos["FALSO_NEGATIVO"]["id"] == 43


def test_acertos_nao_entram_na_lista_de_erros():
    r = avaliar([{"verdadeiro": True, "veredicto": "THEFT_CONFIRMED"}])
    assert r.erros == []


# ── Relatório ──────────────────────────────────────────────────────

def test_relatorio_avisa_sobre_amostra_pequena():
    """Abaixo de ~100 rotulados os percentuais oscilam demais para decidir."""
    texto = formatar_relatorio(avaliar([{"verdadeiro": True, "veredicto": "CLEARED"}]))
    assert "pequena demais" in texto


def test_relatorio_destaca_clientes_inocentes_alertados():
    r = avaliar([{"verdadeiro": False, "veredicto": "THEFT_CONFIRMED",
                  "id": 7, "clipe": "evento_7.mp4"}])
    texto = formatar_relatorio(r)
    assert "inocente" in texto.lower()
    assert "evento_7.mp4" in texto


def test_relatorio_sem_eventos_orienta_o_proximo_passo():
    assert "README" in formatar_relatorio(avaliar([]))
