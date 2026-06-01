import os
import sys
import cv2
import numpy as np

class VivanteBoxes:
    def __init__(self, xyxy, conf, cls, ids=None):
        self.xyxy = np.array(xyxy, dtype=np.float32)
        self.conf = np.array(conf, dtype=np.float32)
        self.cls = np.array(cls, dtype=np.int32)
        self.id = np.array(ids, dtype=np.int32) if ids is not None else None

class VivanteKeypoints:
    def __init__(self, xy, conf):
        self.xy = np.array(xy, dtype=np.float32)      # Shape (N, 17, 2)
        self.conf = np.array(conf, dtype=np.float32)  # Shape (N, 17)

class VivanteResult:
    def __init__(self, boxes, keypoints):
        self.boxes = boxes
        self.keypoints = keypoints

class VivantePoseEngine:
    def __init__(self, model_path):
        self.model_path = model_path
        self.is_npu = False
        self.timvx_context = None
        
        # Extensão .nbg indica modelo compilado para o NPU Vivante
        if model_path.endswith('.nbg'):
            try:
                # Tenta importar a biblioteca do SDK da Vivante no Radxa A7A
                import timvx
                self.is_npu = True
                print(f"[NPU VIVANTE] Inicializando TIM-VX com o modelo NBG: {model_path}")
                # 1. Carrega o grafo de execução NBG
                # (A sintaxe abaixo é típica para wrappers de NBG no TIM-VX)
                self.graph = timvx.Graph()
                self.graph.load_nbg(model_path)
                print("[NPU VIVANTE] ✓ Grafo NBG carregado e pronto para inferência.")
            except ImportError:
                print("[NPU WARNING] SDK 'timvx' não instalado. Rodando em modo CPU Fallback.")
                # Tenta usar modelo PyTorch padrão correspondente se disponível
                self.fallback_to_pytorch()
        else:
            self.fallback_to_pytorch()

    def fallback_to_pytorch(self):
        try:
            from ultralytics import YOLO
            pt_path = self.model_path.replace('.nbg', '.pt')
            if not os.path.exists(pt_path):
                pt_path = 'yolov8n-pose.pt' # Padrão
            print(f"[NPU FALLBACK] Carregando modelo PyTorch em CPU: {pt_path}")
            self.torch_model = YOLO(pt_path)
        except ImportError:
            print("[NPU FATAL] Não foi possível carregar PyTorch para fallback.")
            self.torch_model = None

    def __call__(self, frame, verbose=False):
        if self.is_npu:
            # --- FLUXO NPU ACELERADO (TIM-VX) ---
            # 1. Pré-processamento: Redimensiona para o tamanho de entrada do YOLO (640x480)
            input_w, input_h = 640, 480
            resized = cv2.resize(frame, (input_w, input_h))
            # Normalização (conforme config do pegasus import mean/std)
            input_tensor = resized.astype(np.float32) / 255.0
            
            # 2. Executa a inferência no hardware Vivante
            # (Em TIM-VX, o input tensor é copiado para o tensor de entrada e o grafo é executado)
            self.graph.inputs[0].copy_from(input_tensor)
            self.graph.run()
            
            # 3. Pega os tensores de saída
            # YOLO-Pose retorna caixas e keypoints concatenados
            raw_outputs = [t.copy_to_numpy() for t in self.graph.outputs]
            
            # 4. Pós-processamento de Caixa e Keypoints
            # (Implementação simplificada das coordenadas extraídas do NBG)
            boxes_xyxy = []
            boxes_conf = []
            boxes_cls = []
            keypoints_xy = []
            keypoints_conf = []
            
            # TODO: Mapear os tensores de saída específicos do seu modelo compilado
            # (Geralmente o pós-processamento de NMS é feito na CPU com os tensores brutos)
            
            boxes = VivanteBoxes(boxes_xyxy, boxes_conf, boxes_cls)
            keypoints = VivanteKeypoints(keypoints_xy, keypoints_conf)
            return [VivanteResult(boxes, keypoints)]
            
        else:
            # --- FLUXO CPU FALLBACK (DESENVOLVIMENTO) ---
            if self.torch_model:
                return self.torch_model(frame, verbose=verbose)
            else:
                # Retorno vazio de segurança
                return [VivanteResult(VivanteBoxes([], [], []), VivanteKeypoints([], []))]
