"""
Metricas de runtime compartilhadas entre a engine de visao e o agente local.

A engine mede a latencia de inferencia; quem grava a telemetria e o
`telemetry_sender_loop` do LocalAgent. Como `vision_engine` ja importa
`local_agent`, passar o valor direto criaria um ciclo de imports — este modulo
neutro serve de ponto de encontro para os dois.

Os valores sao escritos por uma thread de inferencia e lidos por uma corrotina
de telemetria. Atribuicao de float em Python e atomica sob o GIL, mas a media
movel le e escreve varios campos, entao ela e protegida por um lock.
"""

import threading

_lock = threading.Lock()
_samples: list = []
_MAX_SAMPLES = 30  # ~6s de historico a 5 FPS


def record_inference(duration_ms: float) -> None:
    """Registra a duracao de um ciclo de inferencia (pose + objetos)."""
    with _lock:
        _samples.append(duration_ms)
        if len(_samples) > _MAX_SAMPLES:
            del _samples[0 : len(_samples) - _MAX_SAMPLES]


def get_avg_inference_ms() -> float:
    """
    Media das amostras recentes, em milissegundos. Retorna 0.0 enquanto
    nenhuma inferencia tiver rodado — o que distingue "engine parada" de
    "engine rapida".
    """
    with _lock:
        if not _samples:
            return 0.0
        return round(sum(_samples) / len(_samples), 2)


def reset() -> None:
    """Descarta o historico. Usado pelos testes."""
    with _lock:
        _samples.clear()
