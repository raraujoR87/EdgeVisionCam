#!/bin/bash
# ==============================================================================
# Script de conversão Acuity Pegasus (para rodar dentro do Docker Acuity Host X86)
# Converte o modelo YOLO-Pose (ONNX) para NBG (Network Binary Graph) para Radxa A7A
# ==============================================================================

MODEL_NAME="yolov8n-pose"
ONNX_PATH="../${MODEL_NAME}.onnx"
OUTPUT_DIR="./output"

mkdir -p ${OUTPUT_DIR}

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
echo "Mova o arquivo ${OUTPUT_DIR}/${MODEL_NAME}.nbg para a pasta 'edge/' no Radxa."
