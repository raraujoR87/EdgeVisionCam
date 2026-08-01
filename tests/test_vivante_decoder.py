"""
Testes do decodificador de saida da NPU Vivante.

O TODO original em `vivante_pose_engine.py` deixava o pos-processamento vazio, o
que fazia a NPU devolver zero deteccoes sempre. Como o hardware Vivante nao esta
disponivel aqui, a validacao ataca a parte determinista do problema — layout dos
tensores, geometria do letterbox e associacao de identidades — usando a saida
real do modelo exportado como referencia.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge.vivante_pose_engine import (  # noqa: E402
    NUM_KEYPOINTS,
    IoUTracker,
    decode_output,
    letterbox,
    nms,
    undo_letterbox_xy,
)


# ── Letterbox ──────────────────────────────────────────────────────

@pytest.mark.parametrize("largura,altura", [(810, 1080), (1920, 1080), (640, 480), (500, 500)])
def test_letterbox_preserva_proporcao(largura, altura):
    frame = np.zeros((altura, largura, 3), dtype=np.uint8)
    canvas, scale, pad_x, pad_y = letterbox(frame, 320)

    assert canvas.shape == (320, 320, 3)
    # O conteudo redimensionado cabe na tela com a proporcao intacta.
    assert round(largura * scale) + 2 * pad_x <= 320 + 1
    assert round(altura * scale) + 2 * pad_y <= 320 + 1


def test_undo_letterbox_e_o_inverso():
    """Ida e volta tem de devolver o ponto de origem, ou as caixas nao caem
    sobre as zonas de guarda desenhadas no dashboard."""
    frame = np.zeros((1080, 810, 3), dtype=np.uint8)
    _, scale, pad_x, pad_y = letterbox(frame, 320)

    original = np.array([[100.0, 200.0], [700.0, 900.0]], dtype=np.float32)
    no_tensor = original * scale + np.array([pad_x, pad_y])
    voltou = undo_letterbox_xy(no_tensor, scale, pad_x, pad_y)

    np.testing.assert_allclose(voltou, original, atol=1e-3)


# ── NMS ────────────────────────────────────────────────────────────

def test_nms_remove_duplicatas():
    boxes = np.array([
        [10, 10, 100, 100],
        [12, 12, 102, 102],   # quase identica a primeira
        [300, 300, 400, 400],
    ], dtype=np.float32)
    scores = np.array([0.9, 0.8, 0.7], dtype=np.float32)

    keep = nms(boxes, scores, iou_threshold=0.45)
    assert sorted(keep) == [0, 2]


def test_nms_mantem_caixas_disjuntas():
    boxes = np.array([[0, 0, 10, 10], [50, 50, 60, 60]], dtype=np.float32)
    scores = np.array([0.9, 0.8], dtype=np.float32)
    assert len(nms(boxes, scores)) == 2


def test_nms_com_entrada_vazia():
    assert nms(np.zeros((0, 4)), np.zeros(0)) == []


# ── Decodificacao ──────────────────────────────────────────────────

def _linha_end_to_end(x1, y1, x2, y2, conf, cls=0):
    linha = np.zeros(6 + NUM_KEYPOINTS * 3, dtype=np.float32)
    linha[:6] = [x1, y1, x2, y2, conf, cls]
    for k in range(NUM_KEYPOINTS):
        linha[6 + k * 3: 9 + k * 3] = [x1 + k, y1 + k, 0.9]
    return linha


def test_decode_end_to_end_filtra_por_confianca():
    raw = np.stack([
        _linha_end_to_end(10, 20, 30, 40, 0.90),
        _linha_end_to_end(50, 60, 70, 80, 0.10),  # abaixo do limiar
    ])[None]

    boxes, scores, classes, kpts_xy, kpts_conf = decode_output(raw, conf_threshold=0.35)

    assert len(boxes) == 1
    np.testing.assert_allclose(boxes[0], [10, 20, 30, 40])
    assert scores[0] == pytest.approx(0.90)
    assert kpts_xy.shape == (1, NUM_KEYPOINTS, 2)
    assert kpts_conf.shape == (1, NUM_KEYPOINTS)


def test_decode_end_to_end_sem_deteccao():
    raw = np.stack([_linha_end_to_end(10, 20, 30, 40, 0.05)])[None]
    boxes, *_ = decode_output(raw, conf_threshold=0.35)
    assert len(boxes) == 0


def test_decode_por_ancoras_converte_cxcywh_para_xyxy():
    """Layout classico do YOLOv8, que e o gerado por compilar_nbg.sh."""
    ancoras = np.zeros((5 + NUM_KEYPOINTS * 3, 3), dtype=np.float32)
    # coluna 0: caixa centrada em (100,100) com 40x60 → (80,70,120,130)
    ancoras[:5, 0] = [100, 100, 40, 60, 0.9]
    ancoras[:5, 1] = [100, 100, 40, 60, 0.85]  # duplicata, deve cair no NMS
    ancoras[:5, 2] = [300, 300, 20, 20, 0.8]

    boxes, scores, classes, _, _ = decode_output(ancoras[None], conf_threshold=0.35)

    assert len(boxes) == 2
    np.testing.assert_allclose(boxes[0], [80, 70, 120, 130])
    assert all(c == 0 for c in classes)


def test_decode_rejeita_layout_desconhecido():
    with pytest.raises(ValueError, match="não reconhecido"):
        decode_output(np.zeros((1, 12, 7)), conf_threshold=0.35)


# ── Paridade com a saida real do modelo ────────────────────────────

def test_layout_bate_com_o_modelo_exportado():
    """
    Trava o contrato do layout end-to-end contra a saida observada do
    `yolo26n-pose` exportado com imgsz=320: 300 linhas de 57 colunas, sendo
    0-3 xyxy no espaco do tensor, 4 confianca, 5 classe e 6+ keypoints.

    Os valores abaixo vieram de uma execucao real sobre `bus.jpg`; as caixas
    correspondem, apos desfazer o letterbox, as que o ultralytics reporta.
    """
    raw = np.zeros((1, 300, 57), dtype=np.float32)
    raw[0, 0, :6] = [105.34, 119.09, 145.07, 253.39, 0.81, 0]
    raw[0, 1, :6] = [54.81, 115.81, 106.97, 268.16, 0.79, 0]
    raw[0, 2, :6] = [243.12, 107.99, 279.42, 258.11, 0.68, 0]

    boxes, scores, classes, kpts_xy, _ = decode_output(raw, conf_threshold=0.35)
    assert len(boxes) == 3
    assert kpts_xy.shape == (3, NUM_KEYPOINTS, 2)

    # bus.jpg tem 810x1080; desfazendo o letterbox de 320 as caixas precisam
    # cair sobre o frame original.
    frame = np.zeros((1080, 810, 3), dtype=np.uint8)
    _, scale, pad_x, pad_y = letterbox(frame, 320)
    no_frame = undo_letterbox_xy(boxes.reshape(-1, 2, 2), scale, pad_x, pad_y).reshape(-1, 4)

    # Referencia do ultralytics para a mesma imagem (tolerancia de 2px cobre a
    # diferenca de arredondamento entre os dois pre-processamentos).
    np.testing.assert_allclose(no_frame[0], [220.3, 402.1, 354.4, 855.3], atol=2.0)

    assert (no_frame[:, 0] >= 0).all() and (no_frame[:, 2] <= 810 + 2).all()
    assert (no_frame[:, 1] >= 0).all() and (no_frame[:, 3] <= 1080 + 2).all()


# ── Paridade contra os modelos ONNX reais ──────────────────────────

ASSET_BUS = "/usr/local/lib/python3.11/dist-packages/ultralytics/assets/bus.jpg"


def _iou_simples(a, b):
    xx1, yy1 = max(a[0], b[0]), max(a[1], b[1])
    xx2, yy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, xx2 - xx1) * max(0.0, yy2 - yy1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


@pytest.mark.parametrize("modelo", ["yolov8n-pose", "yolo26n-pose"])
def test_decoder_reproduz_o_ultralytics(modelo):
    """
    Roda o ONNX real e compara as caixas do decodificador com as que o
    ultralytics produz para a mesma imagem.

    Cobre os dois layouts com dados reais — o caminho por ancoras (YOLOv8) e o
    que `compilar_nbg.sh` compila por padrao, entao validar so o
    end-to-end deixaria justamente o caminho de producao sem cobertura.

    A diferenca residual vem do letterbox: o ultralytics usa retangulo alinhado
    ao stride (320x256) e aqui o quadrado 320x320 e obrigatorio, porque a NPU
    compila um tensor de entrada de tamanho fixo. Por isso a tolerancia e por
    IoU, e nao por pixel.
    """
    ort = pytest.importorskip("onnxruntime")
    pytest.importorskip("ultralytics")

    raiz = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    onnx_path = os.path.join(raiz, f"{modelo}.onnx")
    if not os.path.exists(onnx_path) or not os.path.exists(ASSET_BUS):
        pytest.skip(f"requer {modelo}.onnx — gere com scripts/export_onnx.py")

    import cv2
    from ultralytics import YOLO

    frame = cv2.imread(ASSET_BUS)
    canvas, scale, pad_x, pad_y = letterbox(frame, 320)
    blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0

    sessao = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    raw = sessao.run(None, {"images": blob})[0]

    boxes, scores, _, kpts, _ = decode_output(raw, conf_threshold=0.35)
    obtidas = undo_letterbox_xy(boxes.reshape(-1, 2, 2), scale, pad_x, pad_y).reshape(-1, 4)

    referencia = YOLO(os.path.join(raiz, f"{modelo}.pt"))(
        frame, imgsz=320, verbose=False, conf=0.35
    )[0].boxes.xyxy.cpu().numpy()

    assert len(obtidas) == len(referencia), "contagem de detecções divergiu"

    # Cada caixa precisa ter uma correspondente com sobreposicao alta. Abaixo de
    # 0.9 o problema deixa de ser pre-processamento e passa a ser decodificacao.
    for caixa in obtidas:
        melhor = max(_iou_simples(caixa, r) for r in referencia)
        assert melhor > 0.90, f"IoU {melhor:.3f} baixo demais para {modelo}"

    assert kpts.shape[1:] == (NUM_KEYPOINTS, 2)


# ── Caminho de NPU completo ────────────────────────────────────────

def test_caminho_npu_completo_com_grafo_simulado():
    """
    Exercita `_infer_npu` de ponta a ponta trocando o grafo TIM-VX por um que
    roda o ONNX real do mesmo modelo.

    Cobre o que o hardware nao muda: pre-processamento, decodificacao, volta ao
    espaco do frame e atribuicao de identidades. O que fica de fora e apenas a
    execucao no silicio Vivante e o efeito da quantizacao INT8.
    """
    ort = pytest.importorskip("onnxruntime")
    raiz = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    onnx_path = os.path.join(raiz, "yolo26n-pose.onnx")
    asset = "/usr/local/lib/python3.11/dist-packages/ultralytics/assets/bus.jpg"

    if not os.path.exists(onnx_path) or not os.path.exists(asset):
        pytest.skip(
            "requer yolo26n-pose.onnx (YOLO('yolo26n-pose.pt').export(format='onnx', imgsz=320))"
        )

    import cv2

    from edge.vivante_pose_engine import VivantePoseEngine

    sessao = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    class GrafoFalso:
        """
        Dublê de edge.viplite.Grafo rodando o ONNX real do mesmo modelo.

        Substitui apenas o silício: o letterbox, o decodificador e a volta ao
        espaço do frame são o código de produção. É o que permite validar o
        caminho de NPU inteiro sem a placa — o que falta cobrir é a quantização
        INT8, que só o hardware exerce.
        """

        def inferir(self, blob):
            return [sessao.run(None, {"images": blob})[0]]

    engine = VivantePoseEngine("simulado.nbg")
    engine.is_npu = True
    engine.graph = GrafoFalso()

    frame = cv2.imread(asset)
    resultado = engine.track(frame, conf=0.35)[0]

    # bus.jpg tem tres pessoas acima do limiar.
    assert len(resultado.boxes.xyxy) == 3
    assert resultado.boxes.id is not None
    assert len(set(resultado.boxes.id.tolist())) == 3
    assert resultado.keypoints.xy.shape == (3, NUM_KEYPOINTS, 2)

    # As caixas precisam cair dentro do frame original, nao do tensor 320x320.
    altura, largura = frame.shape[:2]
    caixas = resultado.boxes.xyxy
    assert caixas[:, 2].max() > 320, "coordenadas ficaram no espaço do tensor"
    assert caixas[:, 0].min() >= -2 and caixas[:, 2].max() <= largura + 2
    assert caixas[:, 1].min() >= -2 and caixas[:, 3].max() <= altura + 2


# ── Rastreador ─────────────────────────────────────────────────────

def test_tracker_mantem_id_entre_frames():
    tracker = IoUTracker()
    ids1 = tracker.update([np.array([10, 10, 100, 100], dtype=np.float32)])
    ids2 = tracker.update([np.array([14, 12, 104, 102], dtype=np.float32)])
    assert ids1 == ids2


def test_tracker_atribui_ids_distintos_a_pessoas_distintas():
    tracker = IoUTracker()
    ids = tracker.update([
        np.array([10, 10, 100, 100], dtype=np.float32),
        np.array([300, 300, 400, 400], dtype=np.float32),
    ])
    assert len(set(ids)) == 2


def test_tracker_cria_id_novo_apos_salto_grande():
    """Sem sobreposicao nao ha como afirmar que e a mesma pessoa."""
    tracker = IoUTracker()
    ids1 = tracker.update([np.array([10, 10, 100, 100], dtype=np.float32)])
    ids2 = tracker.update([np.array([500, 500, 600, 600], dtype=np.float32)])
    assert ids1 != ids2


def test_tracker_descarta_faixa_antiga():
    tracker = IoUTracker(max_idade=3)
    ids1 = tracker.update([np.array([10, 10, 100, 100], dtype=np.float32)])
    for _ in range(5):
        tracker.update([])
    ids2 = tracker.update([np.array([10, 10, 100, 100], dtype=np.float32)])
    assert ids1 != ids2


def test_tracker_nao_reusa_id_em_cena_vazia():
    tracker = IoUTracker()
    assert tracker.update([]) == []
