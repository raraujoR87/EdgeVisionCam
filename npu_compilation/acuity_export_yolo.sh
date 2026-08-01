#!/bin/bash
# ==============================================================================
# Conversão ONNX → NBG pelo ACUITY, para a NPU VIP9000 do Allwinner A733.
#
# RODA NO PC (x86), dentro do container do ACUITY — não na placa:
#
#   docker run -it --rm -v "$PWD:/work" -w /work ubuntu-npu:v2.0.10.1 bash
#   bash npu_compilation/acuity_export_yolo.sh
#
# A imagem `ubuntu-npu:v2.0.10.1` traz o ACUITY 6.30.22 e os utilitários
# `pegasus.py` e `pegasus_export_ovx_nbg.sh`. A versão importa: um NBG gerado
# por um ACUITY de versão diferente da do driver VIPLite da placa é recusado no
# carregamento, e a mensagem do runtime não deixa claro que a causa é essa.
# Confira a versão do driver com `bash deploy/npu_diagnostico.sh`.
#
# ATENÇÃO: as invocações do `pegasus` abaixo ainda não foram validadas contra o
# container real desta versão — a CLI varia entre releases do ACUITY. Verifique
# com `pegasus.py --help` dentro do container antes de confiar no resultado.
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

echo "=== 2. Quantizando o modelo ==="
# `pcq` é int8 por canal: cada canal do tensor recebe sua própria escala. Num
# detector isso importa mais que no comum — as cabeças de saída do YOLO têm
# faixas dinâmicas muito diferentes entre si (coordenadas, objectness,
# keypoints), e uma escala única por tensor achata as menores até sumirem, o
# que aparece como queda de recall e não como erro.
QUANTIZADOR="${QUANTIZADOR:-pcq}"

# O arquivo calibrate_dataset.txt deve conter a lista das imagens de calibração
if [ -f "./calibrate_dataset.txt" ]; then
    pegasus quantize \
        --model ${OUTPUT_DIR}/${MODEL_NAME}.json \
        --weights ${OUTPUT_DIR}/${MODEL_NAME}.data \
        --model-quantize ${OUTPUT_DIR}/${MODEL_NAME}.quantize \
        --quantizer ${QUANTIZADOR} \
        --dataset ./calibrate_dataset.txt
else
    echo "ERRO: calibrate_dataset.txt não encontrado."
    echo "Sem calibração o INT8 usa escalas arbitrárias e a precisão despenca"
    echo "no dispositivo — não no teste. Gere antes:"
    echo "  python3 npu_compilation/prepare_calibration.py"
    exit 1
fi

echo "=== 3. Exportando o modelo compilado NBG (Vivante VIP9000) ==="
pegasus export ovx \
    --model ${OUTPUT_DIR}/${MODEL_NAME}.json \
    --weights ${OUTPUT_DIR}/${MODEL_NAME}.data \
    --model-quantize ${OUTPUT_DIR}/${MODEL_NAME}.quantize \
    --output ${OUTPUT_DIR}/${MODEL_NAME}.nbg \
    --target-platform VIP9000

echo "=== COMPILAÇÃO CONCLUÍDA ==="
echo "Copie ${OUTPUT_DIR}/${MODEL_NAME}.nbg para 'edge/' na placa e valide ANTES"
echo "de apontar a engine — vpm_run executa qualquer NBG e isola o problema:"
echo "  vpm_run edge/${MODEL_NAME}.nbg"
echo
echo "Só então:"
echo "  export POSE_MODEL_PATH=edge/${MODEL_NAME}.nbg"
echo
echo "A telemetria registra 'ACTIVE_VIPLITE' quando a NPU assume, e"
echo "'CPU_FALLBACK' quando não. Se cair para CPU, o motivo exato sai em:"
echo "  bash deploy/npu_diagnostico.sh"
