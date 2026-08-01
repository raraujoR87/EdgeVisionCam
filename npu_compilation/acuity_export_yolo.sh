#!/bin/bash
# ==============================================================================
# Script de conversão Acuity Pegasus (para rodar dentro do Docker Acuity Host X86)
# Converte o modelo YOLO-Pose (ONNX) para NBG (Network Binary Graph) para Radxa A7A
# ==============================================================================

# Modelo a compilar. O sistema roda yolo26n-pose na CPU, mas a escolha aqui e
# uma decisao de engenharia, nao uma formalidade:
#
#   yolov8n-pose  Saida por ancoras (56, A). O NMS fica na CPU, feito pelo
#                 decodificador em edge/vivante_pose_engine.py. E o caminho
#                 seguro: sao operacoes que o Acuity/VIP9000 suporta bem.
#   yolo26n-pose  Saida end-to-end (N, 57), com o NMS dentro do grafo. Mais
#                 simples de pos-processar, mas compiladores de NPU costumam
#                 nao suportar os operadores de NMS — verifique se o `pegasus
#                 import` aceita o grafo antes de contar com este caminho.
#
# O decodificador aceita os dois layouts e escolhe pelo formato do tensor.
MODEL_NAME="${MODEL_NAME:-yolov8n-pose}"
ONNX_PATH="../${MODEL_NAME}.onnx"
OUTPUT_DIR="./output"

# Precisa casar com o input_size do VivantePoseEngine e com o imgsz usado no
# export ONNX. Divergir aqui produz caixas deslocadas, nao um erro visivel.
INPUT_SIZE="${INPUT_SIZE:-320}"

mkdir -p ${OUTPUT_DIR}

if [ ! -f "${ONNX_PATH}" ]; then
    echo "ERRO: ${ONNX_PATH} não encontrado."
    echo "Gere o ONNX antes com:"
    echo "  python3 -c \"from ultralytics import YOLO; YOLO('${MODEL_NAME}.pt').export(format='onnx', imgsz=${INPUT_SIZE}, opset=12)\""
    exit 1
fi

echo "=== Modelo: ${MODEL_NAME} | Entrada: ${INPUT_SIZE}x${INPUT_SIZE} ==="

echo "=== 1. Importando modelo ONNX para representação intermediária Acuity ==="
pegasus import onnx \
    --model ${ONNX_PATH} \
    --output ${OUTPUT_DIR}/${MODEL_NAME}.json \
    --weights ${OUTPUT_DIR}/${MODEL_NAME}.data

echo "=== 2. Quantizando o modelo para INT8 ==="
# O arquivo calibrate_dataset.txt deve conter a lista das imagens de calibração
if [ -f "./calibrate_dataset.txt" ]; then
    pegasus quantize \
        --model ${OUTPUT_DIR}/${MODEL_NAME}.json \
        --weights ${OUTPUT_DIR}/${MODEL_NAME}.data \
        --model-quantize ${OUTPUT_DIR}/${MODEL_NAME}.quantize \
        --quantizer int8 \
        --dataset ./calibrate_dataset.txt
else
    echo "Aviso: calibrate_dataset.txt não encontrado! Executando compilação sem quantização INT8."
fi

echo "=== 3. Exportando o modelo compilado NBG (Vivante VIP9000) ==="
pegasus export ovx \
    --model ${OUTPUT_DIR}/${MODEL_NAME}.json \
    --weights ${OUTPUT_DIR}/${MODEL_NAME}.data \
    --model-quantize ${OUTPUT_DIR}/${MODEL_NAME}.quantize \
    --output ${OUTPUT_DIR}/${MODEL_NAME}.nbg \
    --target-platform VIP9000

echo "=== COMPILAÇÃO CONCLUÍDA ==="
echo "Mova ${OUTPUT_DIR}/${MODEL_NAME}.nbg para 'edge/' no Radxa e aponte a engine:"
echo "  export POSE_MODEL_PATH=edge/${MODEL_NAME}.nbg"
echo
echo "A engine registra 'ACTIVE_TIMVX' na telemetria quando a NPU assume."
echo "Se aparecer 'CPU_FALLBACK', o SDK 'timvx' não está instalado no host."
