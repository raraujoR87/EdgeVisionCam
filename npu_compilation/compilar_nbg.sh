#!/bin/bash
# ==============================================================================
# ONNX → NBG para a NPU VIP9000 do Allwinner A733, via ACUITY.
#
# RODA NO PC x86, dentro do container do ACUITY. A placa nao compila modelos:
# o ACUITY e x86-only e o container tem ~11 GB.
#
# Substitui o antigo acuity_export_yolo.sh, cujas invocacoes do `pegasus` eram
# suposicoes. Estas foram transcritas de models/yolov5s-sim/convert_export.sh do
# ai-sdk — um exemplo YOLO que de fato roda nesta familia de NPU.
#
# Tres detalhes que separam um NBG que funciona de um que carrega e devolve lixo:
#
#   --pack-nbg-viplite   O ai-sdk gera `--pack-nbg-unify` por padrao, que produz
#                        um grafo para o driver unificado. Nossa placa roda
#                        VIPLite. O arquivo errado carrega e falha depois.
#   --optimize <PID>     Identifica a configuracao exata do silicio. Um PID de
#                        outra variante compila sem erro e produz um grafo que a
#                        NPU recusa ou executa errado.
#   inputmeta.yml        Descreve o pre-processamento usado na CALIBRACAO. Se
#                        divergir do que a engine faz em runtime, a quantizacao
#                        fica dimensionada para outra distribuicao de entrada e
#                        a precisao cai sem nenhum erro aparente.
#
# Uso (a partir da raiz do repositorio):
#   bash npu_compilation/preparar_host.sh      # confere Docker e imagem
#   python3 npu_compilation/export_onnx.py
#   python3 npu_compilation/prepare_calibration.py
#   bash npu_compilation/compilar_nbg.sh
# ==============================================================================

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 1

MODELO="${MODELO:-yolov8n-pose}"
INPUT_SIZE="${INPUT_SIZE:-320}"
# Vazio = descobre a imagem ubuntu-npu:* mais recente que estiver carregada.
# A Netdisk publica revisoes sem aviso e fixar a versao recusa imagem valida.
IMAGEM="${IMAGEM:-}"

# `pcq` = perchannel_symmetric_affine + qtype int8: cada canal recebe sua propria
# escala. Num detector isso pesa mais que no comum — as cabecas do YOLO (caixas,
# objectness, keypoints) tem faixas dinamicas muito diferentes, e uma escala
# unica por tensor achata as menores ate sumirem. O sintoma e queda de recall,
# nao erro.
QUANT="${QUANT:-pcq}"

# Configuracao do silicio. Vem de machinfo/a733/config.mk do ai-sdk:
#
#     NPU_VERSION    = v3       <- geracao do silicio, escolhe o PID
#     NPU_SW_VERSION = v2.0     <- versao do driver, escolhe as bibliotecas
#
# Sao coisas diferentes, e confundi-las leva ao PID errado: `v2.0` no nome do
# driver nao significa geracao v2. Pelo pegasus_setup.sh, v3 mapeia para
# VIP9000NANODI_PLUS_PID0X1000003B — a mesma familia do t536/t736, nao do t527.
#
# Um PID de outra variante compila sem erro e produz um grafo que a NPU recusa
# ou executa errado, entao esta e a linha a conferir primeiro se o NBG carregar
# e devolver deteccoes sem sentido. Alternativas em npu_compilation/README.md.
OPTIMIZE="${OPTIMIZE:-VIP9000NANODI_PLUS_PID0X1000003B}"

TRABALHO="npu_compilation/trabalho"
ONNX="${MODELO}.onnx"

ok()    { printf "  \033[32m✓\033[0m %s\n" "$1"; }
erro()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
titulo(){ printf "\n\033[1m==> %s\033[0m\n" "$1"; }

# ── Pré-condições ─────────────────────────────────────────────────
titulo "Verificando pré-condições"

if ! command -v docker >/dev/null 2>&1; then
    erro "Docker não instalado. Rode: bash npu_compilation/preparar_host.sh"
    exit 1
fi
if [ -z "$IMAGEM" ]; then
    IMAGEM="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
              | grep '^ubuntu-npu:' | sort -V | tail -1)"
fi
if [ -z "$IMAGEM" ] || ! docker image inspect "$IMAGEM" >/dev/null 2>&1; then
    erro "Nenhuma imagem ubuntu-npu:* carregada."
    echo "  Ela NÃO está no Docker Hub — vem da Allwinner (~11 GB)."
    echo "  Rode: bash npu_compilation/preparar_host.sh"
    exit 1
fi
ok "Docker e imagem $IMAGEM"

if [ ! -f "$ONNX" ]; then
    erro "$ONNX não encontrado."
    echo "  Gere antes: python3 npu_compilation/export_onnx.py --model ${MODELO} --imgsz ${INPUT_SIZE}"
    exit 1
fi
ok "$ONNX"

if [ ! -f "npu_compilation/calibrate_dataset.txt" ]; then
    erro "calibrate_dataset.txt não encontrado."
    echo "  Sem calibração o INT8 usa escalas arbitrárias e a precisão despenca"
    echo "  no dispositivo — não no teste. Gere antes:"
    echo "    python3 npu_compilation/prepare_calibration.py"
    exit 1
fi
ok "Dataset de calibração ($(wc -l < npu_compilation/calibrate_dataset.txt) imagens)"

if [ ! -f "npu_compilation/inputs_outputs.txt" ]; then
    erro "inputs_outputs.txt não encontrado — export_onnx.py o gera."
    exit 1
fi
ok "inputs_outputs.txt: $(cat npu_compilation/inputs_outputs.txt)"

# ── Montagem do diretório de trabalho ─────────────────────────────
# O convert_export.sh do ai-sdk faz `pushd $NAME` e espera todos os arquivos com
# o mesmo prefixo dentro de um diretorio homonimo. Reproduzimos essa estrutura
# em vez de reescrever o fluxo: divergir dela e como os erros aparecem.
titulo "Preparando o diretório de trabalho"
DIR="${TRABALHO}/${MODELO}"
rm -rf "$DIR"
mkdir -p "$DIR/images"

cp "$ONNX" "$DIR/${MODELO}.onnx"
cp npu_compilation/inputs_outputs.txt "$DIR/"

# mean=0 e scale=1/255 espelham o pre-processamento do VivantePoseEngine
# (blob = canvas_rgb / 255.0). Divergir aqui calibra a quantizacao para uma
# distribuicao de entrada que nunca ocorre em producao.
echo "0 0 0 0.00392157" > "$DIR/channel_mean_value.txt"

# O dataset.txt precisa de caminhos relativos ao diretorio do modelo.
: > "$DIR/dataset.txt"
n=0
while IFS= read -r imagem; do
    [ -f "$imagem" ] || continue
    n=$((n + 1))
    destino="images/calib_$(printf '%04d' $n).jpg"
    cp "$imagem" "$DIR/$destino"
    echo "$destino" >> "$DIR/dataset.txt"
done < npu_compilation/calibrate_dataset.txt

if [ "$n" -eq 0 ]; then
    erro "Nenhuma imagem de calibração pôde ser copiada."
    exit 1
fi
ok "$n imagens de calibração em $DIR/images/"

cp "$RAIZ/npu_compilation/convert_export.sh" "$DIR/../convert_export.sh" 2>/dev/null || true

# ── Conversão ─────────────────────────────────────────────────────
titulo "Convertendo dentro do container ACUITY"
echo "  Modelo     : ${MODELO} (${INPUT_SIZE}x${INPUT_SIZE})"
echo "  Quantização: ${QUANT}"
echo "  Otimização : ${OPTIMIZE}"
echo "  Empacotamento: --pack-nbg-viplite (driver desta placa)"
echo

docker run --rm \
    -v "$RAIZ/$TRABALHO:/work" \
    -w /work \
    -e ACUITY_RAIZ=/root \
    -e VIV_RAIZ=/root/Vivante_IDE \
    -e MODELO="$MODELO" \
    -e QUANT="$QUANT" \
    -e OPTIMIZE="$OPTIMIZE" \
    "$IMAGEM" bash -euxo pipefail -c '
# O diretorio carrega a versao do ACUITY no nome e muda entre revisoes da
# imagem; fixa-lo faz a conversao falhar com "arquivo nao encontrado" numa
# imagem valida.
ACUITY_PATH="$(ls -d $ACUITY_RAIZ/acuity-toolkit*/bin 2>/dev/null | head -1)"
if [ -z "$ACUITY_PATH" ]; then
    echo "ERRO: ACUITY nao encontrado em $ACUITY_RAIZ/acuity-toolkit*/bin"
    ls -d $ACUITY_RAIZ/* 2>/dev/null
    exit 1
fi
echo "ACUITY em: $ACUITY_PATH"

# O readme da imagem documenta o caminho como acuity-toolkit-whl-x.x.x — o
# proprio fabricante trata a versao como variavel. O Vivante IDE segue a mesma
# convencao (VivanteIDE5.11.0 nesta revisao), entao tambem e descoberto.
VIV_SDK="$(ls -d $VIV_RAIZ/VivanteIDE*/cmdtools 2>/dev/null | head -1)"
if [ -z "$VIV_SDK" ]; then
    echo "ERRO: Vivante IDE nao encontrado em $VIV_RAIZ/VivanteIDE*/cmdtools"
    ls -d $VIV_RAIZ/* 2>/dev/null
    exit 1
fi
export VIV_SDK
echo "Vivante IDE em: $VIV_SDK"
PEGASUS="$ACUITY_PATH/pegasus"
[ -e "$PEGASUS" ] || PEGASUS="python3 $ACUITY_PATH/pegasus.py"

cd "/work/$MODELO"

# 1. ONNX -> representacao intermediaria do ACUITY
$PEGASUS import onnx \
    --model        "${MODELO}.onnx" \
    --output-model "${MODELO}.json" \
    --output-data  "${MODELO}.data" \
    $(cat inputs_outputs.txt)

# 2. Descricao do pre-processamento usado na calibracao
$PEGASUS generate inputmeta \
    --model             "${MODELO}.json" \
    --separated-database \
    --input-meta-output "${MODELO}_inputmeta.yml"

# Injeta mean/scale de channel_mean_value.txt no inputmeta gerado. O ACUITY
# emite mean=0 scale=1.0 por padrao; sem substituir, a calibracao veria pixels
# 0-255 enquanto a engine alimenta 0-1 em producao.
python3 - <<PYEOF
import re
valores = open("channel_mean_value.txt").read().split()
media, escala = valores[:3], valores[3]
texto = open("${MODELO}_inputmeta.yml").read()
texto = re.sub(r"(mean:\n(?:\s*- [-\d.]+\n)+)",
               "mean:\n" + "".join(f"        - {m}\n" for m in media), texto, count=1)
texto = re.sub(r"(scale:\n(?:\s*- [-\d.]+\n)+)",
               "scale:\n" + "".join(f"        - {escala}\n" for _ in media), texto, count=1)
open("${MODELO}_inputmeta.yml", "w").write(texto)
print("inputmeta ajustado: mean=%s scale=%s" % (media, escala))
PYEOF

$PEGASUS generate postprocess-file \
    --model                   "${MODELO}.json" \
    --postprocess-file-output "${MODELO}_postprocess_file.yml"

# 3. Quantizacao
case "$QUANT" in
  pcq)   QUANTIZER=perchannel_symmetric_affine; QTYPE=int8;      POSTFIX=pcq   ;;
  uint8) QUANTIZER=asymmetric_affine;           QTYPE=uint8;     POSTFIX=uint8 ;;
  int16) QUANTIZER=dynamic_fixed_point;         QTYPE=int16;     POSTFIX=int16 ;;
  bf16)  QUANTIZER=qbfloat16;                   QTYPE=qbfloat16; POSTFIX=bf16  ;;
  *) echo "quantizacao invalida: $QUANT (pcq/uint8/int16/bf16)"; exit 1 ;;
esac

$PEGASUS quantize \
    --model           "${MODELO}.json" \
    --model-data      "${MODELO}.data" \
    --device          CPU \
    --with-input-meta "${MODELO}_inputmeta.yml" \
    --compute-entropy \
    --rebuild \
    --model-quantize  "${MODELO}_${POSTFIX}.quantize" \
    --quantizer       "$QUANTIZER" \
    --qtype           "$QTYPE"

# 4. Exportacao para NBG do VIPLite
SAIDA="./wksp/${MODELO}_${POSTFIX}"
$PEGASUS export ovxlib \
    --model            "${MODELO}.json" \
    --model-data       "${MODELO}.data" \
    --dtype            quantized \
    --model-quantize   "${MODELO}_${POSTFIX}.quantize" \
    --batch-size       1 \
    --save-fused-graph \
    --target-ide-project linux64 \
    --optimize         "$OPTIMIZE" \
    --viv-sdk          "$VIV_SDK" \
    --pack-nbg-unify \
    --with-input-meta  "${MODELO}_inputmeta.yml" \
    --postprocess-file "${MODELO}_postprocess_file.yml" \
    --output-path      "${SAIDA}/${MODELO}_${POSTFIX}"

# O ACUITY nomeia a saida network_binary.nb; o diretorio muda com o modo de
# empacotamento, entao procuramos em vez de supor.
NB=$(find ./wksp -name "network_binary.nb" | head -1)
if [ -z "$NB" ]; then
    echo "ERRO: network_binary.nb nao foi gerado."
    find ./wksp -maxdepth 3 -type d
    exit 1
fi
cp "$NB" "/work/${MODELO}.nb"
echo "NBG gerado: ${MODELO}.nb"
'
RESULTADO=$?

# ── Resultado ─────────────────────────────────────────────────────
NB="${TRABALHO}/${MODELO}.nb"
if [ "$RESULTADO" -ne 0 ] || [ ! -f "$NB" ]; then
    titulo "Falhou"
    erro "O NBG não foi gerado. Log completo acima."
    echo "  Causas frequentes, em ordem:"
    echo "    1. Operador não suportado no import — troque de modelo (README)."
    echo "    2. --optimize com PID errado — ver alternativas no README."
    echo "    3. inputs/outputs incorretos — confira inputs_outputs.txt."
    exit 1
fi

cp "$NB" "edge/${MODELO}.nb"
titulo "Compilação concluída"
ok "edge/${MODELO}.nb ($(du -h "edge/${MODELO}.nb" | cut -f1))"
echo
echo "=========================================================="
echo "  PRÓXIMOS PASSOS — NA PLACA"
echo "=========================================================="
echo "  1. Copie o grafo:"
echo "       scp edge/${MODELO}.nb radxa@<ip>:~/EdgeVisionCam/edge/"
echo
echo "  2. Valide ISOLADO antes de apontar a engine. Isto separa"
echo "     'modelo ruim' de 'integração ruim'. O vpm_run recebe um"
echo "     arquivo de configuração, não o .nb direto:"
echo "       printf '[network]\\n./${MODELO}.nb\\n' > sample.txt"
echo "       vpm_run -s sample.txt"
echo
echo "  3. Só então:"
echo "       POSE_MODEL_PATH=edge/${MODELO}.nb"
echo "       bash deploy/atualizar.sh"
echo
echo "  A telemetria deve passar de CPU_FALLBACK para ACTIVE_VIPLITE."
echo "=========================================================="
