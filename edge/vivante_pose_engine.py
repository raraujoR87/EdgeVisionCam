"""
Adaptador do motor de pose para a NPU Vivante (VIP9000) do Radxa A7A.

Expoe a mesma interface que `vision_engine` usa com o `ultralytics.YOLO`
(`__call__` e `track`), de modo que trocar `POSE_MODEL_PATH` para um arquivo
`.nbg` baste para mover a inferencia da CPU para a NPU.

Formatos de saida suportados
----------------------------
O decodificador aceita os dois layouts que os modelos YOLO-pose produzem, e
escolhe entre eles pelo formato do tensor:

- **End-to-end, `(1, N, 57)`** — YOLO26. Ja vem com NMS aplicado no grafo, e
  cada linha e `[x1, y1, x2, y2, conf, cls, kpt_1x, kpt_1y, kpt_1v, ...]` em
  coordenadas do tensor de entrada. Layout verificado contra a saida do
  `yolo26n-pose.onnx` exportado com `imgsz=320`.
- **Classico, `(1, 56, A)`** — YOLOv8/v11. Sao ancoras brutas
  `[cx, cy, w, h, conf, kpts...]` que exigem transposicao, filtro por confianca
  e NMS na CPU. E o formato que `npu_compilation/acuity_export_yolo.sh` gera,
  ja que ele parte de `yolov8n-pose.onnx`.

Coordenadas
-----------
O pre-processamento usa letterbox (mantem proporcao e preenche com 114), e o
pos-processamento desfaz o padding e a escala. Sem isso as caixas saem
distorcidas e nao correspondem as zonas de guarda desenhadas no dashboard,
que vivem no espaco do frame original.
"""

import os

import cv2
import numpy as np

# Valor de preenchimento do letterbox. 114 e a convencao do YOLO; usar outro
# desloca a estatistica de entrada em relacao ao dataset de calibracao INT8.
LETTERBOX_PAD = 114

NUM_KEYPOINTS = 17  # esqueleto COCO


class VivanteBoxes:
    def __init__(self, xyxy, conf, cls, ids=None):
        self.xyxy = np.array(xyxy, dtype=np.float32).reshape(-1, 4)
        self.conf = np.array(conf, dtype=np.float32).reshape(-1)
        self.cls = np.array(cls, dtype=np.int32).reshape(-1)
        self.id = np.array(ids, dtype=np.int32).reshape(-1) if ids is not None else None

    def __len__(self):
        return len(self.xyxy)


class VivanteKeypoints:
    def __init__(self, xy, conf):
        self.xy = np.array(xy, dtype=np.float32).reshape(-1, NUM_KEYPOINTS, 2)
        self.conf = np.array(conf, dtype=np.float32).reshape(-1, NUM_KEYPOINTS)


class VivanteResult:
    def __init__(self, boxes, keypoints):
        self.boxes = boxes
        self.keypoints = keypoints


# ──────────────────────────────────────────────────────────────────
# Pre e pos-processamento
# ──────────────────────────────────────────────────────────────────

def letterbox(frame, size):
    """
    Redimensiona mantendo a proporcao e centraliza sobre um fundo neutro.

    Devolve (imagem, escala, pad_x, pad_y) — os tres ultimos sao necessarios
    para trazer as deteccoes de volta ao espaco do frame original.
    """
    h, w = frame.shape[:2]
    scale = min(size / w, size / h)
    new_w, new_h = int(round(w * scale)), int(round(h * scale))
    pad_x, pad_y = (size - new_w) // 2, (size - new_h) // 2

    canvas = np.full((size, size, 3), LETTERBOX_PAD, dtype=np.uint8)
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = cv2.resize(frame, (new_w, new_h))
    return canvas, scale, pad_x, pad_y


def undo_letterbox_xy(coords, scale, pad_x, pad_y):
    """Converte coordenadas do tensor de entrada de volta ao frame original."""
    out = np.array(coords, dtype=np.float32).copy()
    out[..., 0] = (out[..., 0] - pad_x) / scale
    out[..., 1] = (out[..., 1] - pad_y) / scale
    return out


def nms(boxes, scores, iou_threshold=0.45):
    """
    Supressao de nao-maximos sobre caixas xyxy. Necessaria apenas para o layout
    classico; o end-to-end ja sai filtrado do grafo.
    """
    if len(boxes) == 0:
        return []

    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break

        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])

        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        iou = np.where(union > 0, inter / union, 0.0)

        order = rest[iou <= iou_threshold]

    return keep


def decode_end_to_end(raw, conf_threshold):
    """
    Decodifica `(N, 57)` — saida ja filtrada do YOLO26.

    Colunas: 0-3 xyxy, 4 confianca, 5 classe, 6+ keypoints em triplas (x, y, v).
    """
    if raw.size == 0:
        return np.zeros((0, 4)), np.zeros(0), np.zeros(0, dtype=int), \
               np.zeros((0, NUM_KEYPOINTS, 2)), np.zeros((0, NUM_KEYPOINTS))

    keep = raw[raw[:, 4] >= conf_threshold]
    if keep.size == 0:
        return np.zeros((0, 4)), np.zeros(0), np.zeros(0, dtype=int), \
               np.zeros((0, NUM_KEYPOINTS, 2)), np.zeros((0, NUM_KEYPOINTS))

    boxes = keep[:, 0:4]
    scores = keep[:, 4]
    classes = keep[:, 5].astype(int)

    kpts = keep[:, 6:6 + NUM_KEYPOINTS * 3].reshape(-1, NUM_KEYPOINTS, 3)
    return boxes, scores, classes, kpts[..., 0:2], kpts[..., 2]


def decode_anchors(raw, conf_threshold, iou_threshold=0.45):
    """
    Decodifica `(56, A)` — ancoras brutas do YOLOv8/v11-pose.

    Linhas: 0-3 cxcywh, 4 confianca, 5+ keypoints em triplas. Exige transposicao,
    conversao para xyxy e NMS.
    """
    pred = raw.T  # (A, 56)
    scores = pred[:, 4]
    mask = scores >= conf_threshold
    pred, scores = pred[mask], scores[mask]

    if pred.size == 0:
        return np.zeros((0, 4)), np.zeros(0), np.zeros(0, dtype=int), \
               np.zeros((0, NUM_KEYPOINTS, 2)), np.zeros((0, NUM_KEYPOINTS))

    cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
    boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)

    keep = nms(boxes, scores, iou_threshold)
    boxes, scores, pred = boxes[keep], scores[keep], pred[keep]

    kpts = pred[:, 5:5 + NUM_KEYPOINTS * 3].reshape(-1, NUM_KEYPOINTS, 3)
    # O modelo de pose tem uma unica classe (pessoa).
    classes = np.zeros(len(boxes), dtype=int)
    return boxes, scores, classes, kpts[..., 0:2], kpts[..., 2]


def decode_output(raw, conf_threshold, iou_threshold=0.45):
    """Escolhe o decodificador pelo formato do tensor."""
    arr = np.asarray(raw, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr[0]

    if arr.ndim != 2:
        raise ValueError(f"Tensor de saída com formato inesperado: {arr.shape}")

    # (N, 57) end-to-end contra (56, A) por ancoras. A distincao e pela segunda
    # dimensao: 57 colunas indicam o formato ja decodificado.
    if arr.shape[1] == 6 + NUM_KEYPOINTS * 3:
        return decode_end_to_end(arr, conf_threshold)
    if arr.shape[0] == 5 + NUM_KEYPOINTS * 3:
        return decode_anchors(arr, conf_threshold, iou_threshold)

    raise ValueError(
        f"Layout de saída não reconhecido: {arr.shape}. "
        f"Esperado (N, {6 + NUM_KEYPOINTS * 3}) ou ({5 + NUM_KEYPOINTS * 3}, A)."
    )


# ──────────────────────────────────────────────────────────────────
# Rastreamento
# ──────────────────────────────────────────────────────────────────

class IoUTracker:
    """
    Rastreador por sobreposicao, suficiente para manter identidades estaveis
    entre frames consecutivos.

    O caminho de CPU usa o BoT-SORT do ultralytics, que combina movimento e
    aparencia; aqui a associacao e apenas geometrica. Para uma camera fixa de
    loja, com pessoas em deslocamento lento e inferencia a 5 FPS, a sobreposicao
    entre frames e alta e a associacao se sustenta — mas trocas de identidade
    sao possiveis em oclusao ou cruzamento.
    """

    def __init__(self, iou_threshold=0.3, max_idade=15):
        self.iou_threshold = iou_threshold
        self.max_idade = max_idade
        self._proximo_id = 1
        self._faixas = {}  # id -> {"box": xyxy, "idade": frames sem ver}

    @staticmethod
    def _iou(a, b):
        xx1, yy1 = max(a[0], b[0]), max(a[1], b[1])
        xx2, yy2 = min(a[2], b[2]), min(a[3], b[3])
        inter = max(0.0, xx2 - xx1) * max(0.0, yy2 - yy1)
        area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
        area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
        union = area_a + area_b - inter
        return inter / union if union > 0 else 0.0

    def update(self, boxes):
        """Devolve um id por caixa, na mesma ordem recebida."""
        for faixa in self._faixas.values():
            faixa["idade"] += 1

        ids = [-1] * len(boxes)
        disponiveis = set(self._faixas.keys())

        # Associacao gulosa pelo melhor IoU. Com poucas pessoas em cena o custo
        # e irrelevante e o resultado empata com o hungaro.
        pares = []
        for idx, box in enumerate(boxes):
            for tid in disponiveis:
                iou = self._iou(box, self._faixas[tid]["box"])
                if iou >= self.iou_threshold:
                    pares.append((iou, idx, tid))
        pares.sort(reverse=True)

        usados_idx, usados_tid = set(), set()
        for _, idx, tid in pares:
            if idx in usados_idx or tid in usados_tid:
                continue
            ids[idx] = tid
            self._faixas[tid] = {"box": boxes[idx], "idade": 0}
            usados_idx.add(idx)
            usados_tid.add(tid)

        for idx, box in enumerate(boxes):
            if ids[idx] == -1:
                tid = self._proximo_id
                self._proximo_id += 1
                ids[idx] = tid
                self._faixas[tid] = {"box": box, "idade": 0}

        for tid in [t for t, f in self._faixas.items() if f["idade"] > self.max_idade]:
            del self._faixas[tid]

        return ids


# ──────────────────────────────────────────────────────────────────
# Motor
# ──────────────────────────────────────────────────────────────────

class VivantePoseEngine:
    def __init__(self, model_path, input_size=320):
        self.model_path = model_path
        self.input_size = input_size
        self.is_npu = False
        self.graph = None
        self.torch_model = None
        self.tracker = IoUTracker()

        if model_path.endswith('.nbg'):
            self._carregar_npu(model_path)
        else:
            self.fallback_to_pytorch()

    def _carregar_npu(self, model_path):
        """
        Carrega o grafo NBG pelo runtime VIPLite.

        Este caminho antes fazia `import timvx` e chamava `timvx.Graph()`. Essa
        API nao existe: TIM-VX e uma biblioteca C++ da VeriSilicon, sem esse
        binding em Python, e nao e a pilha do A733 de todo modo. O `except
        ImportError` engolia a falha e caia para CPU em silencio, o que fez o
        codigo parecer pronto para NPU por meses sem nunca ter executado nela.

        A pilha correta do A733 e VIPLite: node /dev/vipcore, modulo de kernel
        `sunxi_npu`, bibliotecas libVIPhal.so/libNBGlinker.so vindas do ai-sdk
        da Radxa. O binding e montado por edge/viplite.py sobre os headers
        instalados na placa.
        """
        from edge import viplite

        disponivel, motivo = viplite.disponivel()
        if not disponivel:
            # Falha explicita, com a causa exata. Antes so se via "SDK nao
            # instalado" — indistinguivel de driver ausente, modelo faltando ou
            # biblioteca incompativel, que exigem acoes completamente diferentes.
            print(f"[NPU] Aceleracao indisponivel: {motivo}")
            print("[NPU] Diagnostico completo: bash deploy/npu_diagnostico.sh")
            self.fallback_to_pytorch()
            return

        if not os.path.exists(model_path):
            print(f"[NPU] Modelo {model_path} nao encontrado. Compile com npu_compilation/.")
            self.fallback_to_pytorch()
            return

        try:
            print(f"[NPU VIPLITE] Carregando grafo NBG: {model_path}")
            self.graph = viplite.Grafo(model_path)
            self.is_npu = True
            print(f"[NPU VIPLITE] Grafo carregado. Driver {viplite.versao()}.")
        except Exception as erro:
            print(f"[NPU] Falha ao carregar o grafo: {erro}")
            self.fallback_to_pytorch()

    def fallback_to_pytorch(self):
        try:
            from ultralytics import YOLO

            pt_path = self.model_path.replace('.nbg', '.pt')
            if not os.path.exists(pt_path):
                # Mesmo padrao do resto do sistema — ver POSE_MODEL_PATH em
                # edge/vision_engine.py.
                pt_path = 'yolo26n-pose.pt'
            print(f"[NPU FALLBACK] Carregando modelo PyTorch em CPU: {pt_path}")
            self.torch_model = YOLO(pt_path)
        except ImportError:
            print("[NPU FATAL] Não foi possível carregar PyTorch para fallback.")
            self.torch_model = None

    def _infer_npu(self, frame, conf):
        canvas, scale, pad_x, pad_y = letterbox(frame, self.input_size)

        # NCHW, RGB, normalizado — mesma convencao usada na calibracao INT8.
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0

        self.graph.inputs[0].copy_from(blob)
        self.graph.run()
        raw_outputs = [t.copy_to_numpy() for t in self.graph.outputs]

        boxes, scores, classes, kpts_xy, kpts_conf = decode_output(raw_outputs[0], conf)

        # Traz tudo para o espaco do frame original, onde vivem as zonas.
        if len(boxes):
            cantos = undo_letterbox_xy(boxes.reshape(-1, 2, 2), scale, pad_x, pad_y)
            boxes = cantos.reshape(-1, 4)
            kpts_xy = undo_letterbox_xy(kpts_xy, scale, pad_x, pad_y)

        ids = self.tracker.update(boxes) if len(boxes) else []
        return [VivanteResult(
            VivanteBoxes(boxes, scores, classes, ids if len(boxes) else None),
            VivanteKeypoints(kpts_xy, kpts_conf),
        )]

    def __call__(self, frame, conf=0.35, verbose=False, **kwargs):
        if self.is_npu:
            return self._infer_npu(frame, conf)
        if self.torch_model:
            return self.torch_model(frame, conf=conf, verbose=verbose, **kwargs)
        return [VivanteResult(VivanteBoxes([], [], []), VivanteKeypoints([], []))]

    def track(self, frame, conf=0.35, verbose=False, **kwargs):
        """
        Contraparte de `YOLO.track`.

        `vision_engine` chama `track()` e le `boxes.id`; sem este metodo a NPU
        quebrava no warmup com AttributeError, antes de qualquer inferencia.
        Argumentos especificos do ultralytics (`persist`, `tracker`, `imgsz`)
        sao aceitos e ignorados no caminho de NPU, que usa o IoUTracker.
        """
        if self.is_npu:
            return self._infer_npu(frame, conf)
        if self.torch_model:
            return self.torch_model.track(frame, conf=conf, verbose=verbose, **kwargs)
        return [VivanteResult(VivanteBoxes([], [], []), VivanteKeypoints([], []))]
