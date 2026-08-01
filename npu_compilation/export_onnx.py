"""
Exporta o modelo de pose para ONNX, primeiro passo da compilacao para a NPU.

O fluxo completo e:

    1. export_onnx.py          → <modelo>.onnx
    2. prepare_calibration.py  → calibrate_dataset.txt (quantizacao INT8)
    3. acuity_export_yolo.sh   → <modelo>.nbg          (dentro do Docker Acuity)

Uso:
    python3 npu_compilation/export_onnx.py                     # yolov8n-pose, 320
    python3 npu_compilation/export_onnx.py --model yolo26n-pose
    python3 npu_compilation/export_onnx.py --imgsz 640
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default="yolov8n-pose",
        help=(
            "Modelo a exportar. O padrão é yolov8n-pose: sua saída por âncoras "
            "usa apenas operadores que o compilador Acuity suporta com "
            "segurança. O yolo26n-pose embute o NMS no grafo, o que costuma "
            "não ser suportado por compiladores de NPU."
        ),
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=320,
        help=(
            "Lado do tensor de entrada quadrado. Precisa casar com o "
            "input_size do VivantePoseEngine e com o INPUT_SIZE do script "
            "Acuity — divergir produz caixas deslocadas, não um erro visível."
        ),
    )
    parser.add_argument("--opset", type=int, default=12, help="Versão do opset ONNX.")
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print("ERRO: ultralytics não instalado. Rode: pip install -r requirements.txt")
        return 1

    print(f"=== Exportando {args.model} @ {args.imgsz}x{args.imgsz} (opset {args.opset}) ===")
    modelo = YOLO(f"{args.model}.pt")
    caminho = modelo.export(format="onnx", imgsz=args.imgsz, opset=args.opset)

    print(f"\n[OK] ONNX gerado: {caminho}")

    # Reporta o layout de saida, que determina qual ramo do decodificador em
    # edge/vivante_pose_engine.py sera exercitado no dispositivo.
    try:
        import onnxruntime as ort

        sessao = ort.InferenceSession(caminho, providers=["CPUExecutionProvider"])
        forma = sessao.get_outputs()[0].shape
        print(f"     Formato de saída: {forma}")

        if len(forma) == 3 and forma[2] == 57:
            print("     Layout: end-to-end (NMS no grafo).")
            print("     ATENÇÃO: verifique se o `pegasus import` aceita os operadores de NMS.")
        elif len(forma) == 3 and forma[1] == 56:
            print("     Layout: por âncoras (NMS na CPU). Caminho seguro para o Acuity.")
        else:
            print("     Layout não reconhecido pelo decodificador — verifique antes de compilar.")
    except ImportError:
        print("     (instale onnxruntime para inspecionar o layout de saída)")

    print("\nPróximo passo: python3 npu_compilation/prepare_calibration.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
