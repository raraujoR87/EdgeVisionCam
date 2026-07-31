"""
Testes das metricas de inferencia.

A telemetria gravava `inference_ms = 0.0` fixo, entao a coluna nao servia para
diagnosticar queda de desempenho no appliance. Estes testes travam o
comportamento do canal que passou a alimentar esse valor.
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from shared import metrics  # noqa: E402


@pytest.fixture(autouse=True)
def limpa_metricas():
    metrics.reset()
    yield
    metrics.reset()


def test_sem_amostras_retorna_zero():
    """Zero distingue 'engine parada' de 'engine rapida'."""
    assert metrics.get_avg_inference_ms() == 0.0


def test_media_de_uma_amostra():
    metrics.record_inference(120.0)
    assert metrics.get_avg_inference_ms() == 120.0


def test_media_de_varias_amostras():
    for valor in (100.0, 200.0, 300.0):
        metrics.record_inference(valor)
    assert metrics.get_avg_inference_ms() == 200.0


def test_historico_e_limitado():
    """A janela deslizante evita que uma engine longeva acumule memoria e
    mantem a media representando o desempenho recente."""
    for _ in range(metrics._MAX_SAMPLES * 3):
        metrics.record_inference(50.0)
    assert len(metrics._samples) == metrics._MAX_SAMPLES

    for _ in range(metrics._MAX_SAMPLES):
        metrics.record_inference(150.0)
    assert metrics.get_avg_inference_ms() == 150.0


def test_escrita_concorrente_nao_perde_amostras():
    """A engine escreve de uma thread de inferencia enquanto a telemetria le
    de uma corrotina — o acesso precisa ser seguro."""
    metrics._MAX_SAMPLES_original = metrics._MAX_SAMPLES

    def worker():
        for _ in range(200):
            metrics.record_inference(10.0)
            metrics.get_avg_inference_ms()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(metrics._samples) == metrics._MAX_SAMPLES
    assert metrics.get_avg_inference_ms() == 10.0
