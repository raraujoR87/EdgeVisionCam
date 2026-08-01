#!/bin/bash
# ==============================================================================
# Coleta as imagens de calibração NA PLACA, para levar ao PC que compila.
#
# A quantização INT8 dimensiona as escalas de cada tensor a partir destas
# imagens. Se elas não se parecerem com o que a câmera realmente vê — a
# iluminação da loja, o ângulo, a distância das pessoas, a cor das prateleiras —
# as escalas ficam calibradas para outra distribuição e a precisão cai no
# dispositivo. Não no teste: o teste roda o ONNX em float e continua verde.
#
# Este script existe porque a câmera e o system.db vivem aqui, não no PC x86 que
# roda o ACUITY. Sem ele, o único caminho disponível lá seria o COCO — imagens
# genéricas, exatamente o que degrada o resultado.
#
# Roda dentro do container visioncam-core, que já tem OpenCV e enxerga o banco
# e os clipes. Instalar OpenCV no host da placa só para isso seria desperdício.
#
# Uso:  bash npu_compilation/coletar_calibracao.sh
#       QUANTIDADE=150 bash npu_compilation/coletar_calibracao.sh
# ==============================================================================

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 1

CONTAINER="${CONTAINER:-visioncam-core}"
QUANTIDADE="${QUANTIDADE:-100}"
DESTINO="npu_compilation/calibration_images"

ok()    { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso() { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
titulo(){ printf "\n\033[1m==> %s\033[0m\n" "$1"; }

titulo "Verificando o appliance"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    erro "Container $CONTAINER não está rodando."
    echo "  A coleta usa o OpenCV e o banco que vivem dentro dele."
    echo "  Suba a stack antes:  docker compose up -d"
    exit 1
fi
ok "$CONTAINER no ar"

titulo "Coletando $QUANTIDADE imagens da cena real"
echo "  Ordem de preferência: câmera ao vivo → clipes de evento → COCO."
echo

# O repositório é montado no container em /app, então o script já está lá.
docker exec "$CONTAINER" python3 /app/npu_compilation/prepare_calibration.py \
    --quantidade "$QUANTIDADE" 2>&1 | sed 's/^/    /'
RESULTADO=${PIPESTATUS[0]}

if [ "$RESULTADO" -ne 0 ]; then
    erro "A coleta falhou dentro do container."
    exit 1
fi

titulo "Resultado"
if [ ! -d "$DESTINO" ]; then
    erro "$DESTINO não foi criado."
    echo "  O container escreve em /app/npu_compilation/calibration_images."
    echo "  Confirme que o repositório está montado em /app:"
    echo "    docker inspect $CONTAINER --format '{{json .Mounts}}'"
    exit 1
fi

TOTAL=$(find "$DESTINO" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.png' \) | wc -l)
if [ "$TOTAL" -eq 0 ]; then
    erro "Nenhuma imagem coletada."
    exit 1
fi
ok "$TOTAL imagens em $DESTINO"

# Distinguir a origem importa: COCO significa que nem a camera nem os clipes
# foram alcancados, e o resultado da compilacao sera pior sem que nada acuse.
CAM=$(find "$DESTINO" -name 'cam_*' | wc -l)
CLIPES=$(find "$DESTINO" -name 'clipe_*' | wc -l)
COCO=$(find "$DESTINO" -name 'coco_*' | wc -l)
[ "$CAM" -gt 0 ]    && ok "$CAM da câmera ao vivo (melhor caso)"
[ "$CLIPES" -gt 0 ] && ok "$CLIPES de clipes de evento (cena real da loja)"
if [ "$COCO" -gt 0 ]; then
    aviso "$COCO genéricas do COCO — não representam esta loja."
    aviso "Se a câmera estiver no ar, vale investigar antes de compilar:"
    aviso "  docker exec $CONTAINER python3 -c \"import sqlite3;\\"
    aviso "    print(sqlite3.connect('/app/core/database/data/system.db')\\"
    aviso "    .execute('SELECT rtsp_url,is_active FROM cameras').fetchall())\""
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "=========================================================="
echo "  LEVE AS IMAGENS PARA O PC QUE COMPILA"
echo "=========================================================="
echo "  No PC (WSL), dentro do clone do repositório:"
echo
echo "    scp -r $(whoami)@${IP:-IP-DA-PLACA}:$RAIZ/$DESTINO \\"
echo "      ./npu_compilation/"
echo
echo "    python3 npu_compilation/prepare_calibration.py \\"
echo "      --dir npu_compilation/calibration_images"
echo "=========================================================="
