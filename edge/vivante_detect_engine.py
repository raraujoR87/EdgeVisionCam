import os
import cv2
import numpy as np

# Copiado das dependências do vivante_pose_engine.py
from edge.vivante_pose_engine import _NumpyTensorCompat, _NumpyArray, letterbox, undo_letterbox_xy, EXTENSOES_NBG

class DetectBoxes(_NumpyTensorCompat):
    def __init__(self, xyxy, conf, cls):
        self.xyxy = _NumpyArray(xyxy, np.float32, (-1, 4))
        self.conf = _NumpyArray(conf, np.float32, (-1,))
        self.cls = _NumpyArray(cls, np.int32, (-1,))
        self.id = None # Tracker preenche depois

class DetectResults:
    def __init__(self, boxes_obj):
        self.boxes = boxes_obj
        self.keypoints = None # YOLO de deteccao nao tem keypoints

def decode_detect_output(raw, conf_threshold):
    arr = np.asarray(raw, dtype=np.float32)
    
    # NBG com formato [1, 300, 6] ou similar (end-to-end com NMS)
    if arr.ndim == 3 and arr.shape[-1] == 6:
        if arr.shape[0] == 1:
            arr = arr[0]
        elif arr.shape[1] == 1:
            arr = arr.reshape(-1, 6)
            
        keep = arr[arr[:, 4] >= conf_threshold]
        if keep.size == 0:
            return np.zeros((0, 4)), np.zeros(0), np.zeros(0, dtype=int)
            
        boxes = keep[:, 0:4]
        scores = keep[:, 4]
        classes = keep[:, 5].astype(int)
        return boxes, scores, classes

    # Caso nao reconhecido
    return np.zeros((0, 4)), np.zeros(0), np.zeros(0, dtype=int)

class VivanteDetectEngine:
    def __init__(self, model_path, input_size=640):
        self.model_path = model_path
        self.input_size = input_size
        self.is_npu = False
        self.graph = None
        self.torch_model = None

        if model_path.endswith(EXTENSOES_NBG):
            self._carregar_npu(model_path)
        else:
            self.fallback_to_pytorch()

    def _carregar_npu(self, model_path):
        from edge import viplite
        disponivel, motivo = viplite.disponivel()
        if not disponivel:
            print(f"[NPU] Aceleracao indisponivel para detecao: {motivo}")
            self.fallback_to_pytorch()
            return

        if not os.path.exists(model_path):
            print(f"[NPU] Modelo {model_path} nao encontrado.")
            self.fallback_to_pytorch()
            return

        try:
            print(f"[NPU VIPLITE] Carregando grafo NBG Detecao: {model_path}")
            self.graph = viplite.Grafo(model_path)
            self.is_npu = True
            print(f"[NPU VIPLITE] Grafo Detecao carregado. Driver {viplite.versao()}.")
        except Exception as erro:
            print(f"[NPU] Falha ao carregar o grafo de detecao: {erro}")
            self.fallback_to_pytorch()

    def fallback_to_pytorch(self):
        try:
            from ultralytics import YOLO
            pt_path = self.model_path
            for extensao in EXTENSOES_NBG:
                if pt_path.endswith(extensao):
                    pt_path = pt_path[: -len(extensao)] + '.pt'
                    break
            if not os.path.exists(pt_path):
                pt_path = 'yolo26s.pt'
            print(f"[NPU FALLBACK] Carregando modelo PyTorch em CPU para detecao: {pt_path}")
            self.torch_model = YOLO(pt_path)
        except ImportError:
            print("[NPU FATAL] PyTorch fallback de detecao indisponivel.")
            self.torch_model = None

    def __call__(self, frame, imgsz=None, verbose=False, conf=0.20):
        if not self.is_npu:
            if self.torch_model:
                return self.torch_model(frame, imgsz=imgsz or self.input_size, verbose=verbose, conf=conf)
            return []

        sz = imgsz or self.input_size
        canvas, scale, pad_x, pad_y = letterbox(frame, sz)
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        
        raw_outputs = self.graph.inferir(blob)
        boxes, scores, classes = decode_detect_output(raw_outputs[0], conf)

        if len(boxes):
            cantos = undo_letterbox_xy(boxes.reshape(-1, 2, 2), scale, pad_x, pad_y)
            boxes = cantos.reshape(-1, 4)

        b_obj = DetectBoxes(boxes, scores, classes)
        return [DetectResults(b_obj)]
