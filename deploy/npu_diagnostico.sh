#!/bin/bash
# ==============================================================================
# Levantamento da NPU do Allwinner A733 (VeriSilicon VIP9000 / VIPLite).
#
# Este arquivo existe porque o projeto passou meses procurando /dev/galcore, que
# e o node da pilha Vivante classica usada em OUTROS SoCs. O A733 usa VIPLite, e
# o node e /dev/vipcore. A consequencia: a telemetria reportava aceleracao ativa
# enquanto tudo rodava em CPU, e o diagnostico de hardware dizia "NPU ausente"
# sem que ninguem checasse o node certo.
#
# Coleta, de uma vez:
#   - o que existe da pilha VIPLite nesta placa
#   - onde estao as bibliotecas e os headers
#   - a versao do driver, que precisa casar com a do ACUITY que compilou o NBG
#
# Uso:  bash deploy/npu_diagnostico.sh
#       bash deploy/npu_diagnostico.sh > npu.txt   (para colar depois)
# ==============================================================================

set -uo pipefail

titulo() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
ok()     { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso()  { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()   { printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo "=========================================================="
echo "  DIAGNÓSTICO DA NPU — Allwinner A733 / VIP9000"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================================="
echo "  Kernel : $(uname -r)"
echo "  Modelo : $(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo '?')"

# ── Node de dispositivo ───────────────────────────────────────────
titulo "Node de dispositivo"
if [ -e /dev/vipcore ]; then
    ok "/dev/vipcore presente"
    ls -l /dev/vipcore | sed 's/^/    /'
    # Sem permissao aqui, o container roda como se a NPU nao existisse.
    if [ -r /dev/vipcore ] && [ -w /dev/vipcore ]; then
        ok "Leitura e escrita liberadas para o usuário atual."
    else
        aviso "Sem permissão de leitura/escrita — a inferência cairá para CPU."
        aviso "Verifique o grupo dono do node."
    fi
else
    erro "/dev/vipcore AUSENTE — sem ele não há aceleração."
fi
# /dev/galcore e verificado so para registrar que a suposicao antiga era falsa.
[ -e /dev/galcore ] && aviso "/dev/galcore também existe (incomum neste SoC)."

# ── Módulo de kernel ──────────────────────────────────────────────
titulo "Módulo de kernel"
if grep -q '^sunxi_npu' /proc/modules 2>/dev/null; then
    ok "sunxi_npu carregado"
    grep '^sunxi_npu' /proc/modules | sed 's/^/    /'
else
    aviso "sunxi_npu não está carregado."
    # Distinguir 'nao existe' de 'existe e nao carregou' e a diferenca entre
    # trocar a imagem do sistema e rodar um modprobe.
    ENCONTRADO=$(find "/lib/modules/$(uname -r)" -name 'sunxi_npu*' 2>/dev/null | head -3)
    if [ -n "$ENCONTRADO" ]; then
        ok "  Mas o módulo EXISTE:"
        echo "$ENCONTRADO" | sed 's/^/      /'
        aviso "  Carregue com: sudo modprobe sunxi_npu"
    else
        erro "  Nenhum módulo sunxi_npu neste kernel."
        aviso "  A NPU depende da imagem de sistema da Radxa com o driver VIPLite."
    fi
fi
# Alguns BSPs nomeiam o modulo de outra forma; listar o que ha ajuda.
echo "  Módulos com 'npu' ou 'vip' no nome:"
grep -iE '^(.*npu|.*vip)' /proc/modules 2>/dev/null | sed 's/^/    /' || echo "    (nenhum)"

# ── Bibliotecas do runtime ────────────────────────────────────────
titulo "Bibliotecas VIPLite"
# Sem estas, o binding nao tem o que carregar mesmo com o driver ativo.
ACHOU_LIB=0
for lib in libVIPhal.so libNBGlinker.so libvip_lite.so libArchModelSw.so; do
    CAMINHOS=$(find /usr /opt /home /lib -name "$lib" 2>/dev/null | head -3)
    if [ -n "$CAMINHOS" ]; then
        ok "$lib"
        echo "$CAMINHOS" | sed 's/^/      /'
        ACHOU_LIB=1
    else
        aviso "$lib não encontrada"
    fi
done
if [ "$ACHOU_LIB" -eq 0 ]; then
    erro "Nenhuma biblioteca VIPLite no sistema — o ai-sdk não está instalado."
fi
echo "  LD_LIBRARY_PATH: ${LD_LIBRARY_PATH:-(vazio)}"

# ── Headers ───────────────────────────────────────────────────────
titulo "Headers do VIPLite"
# Sao eles que definem as assinaturas da API C. Sem os headers, escrever o
# binding em ctypes seria adivinhar tipos e ordem de argumentos — que e
# justamente o defeito que estamos corrigindo.
HEADERS=$(find /usr /opt /home -name 'vip_lite.h' -o -name 'vip_*.h' 2>/dev/null | head -10)
if [ -n "$HEADERS" ]; then
    ok "Headers encontrados:"
    echo "$HEADERS" | sed 's/^/      /'
    PRIMEIRO=$(echo "$HEADERS" | head -1)
    echo
    echo "  --- assinaturas em $(basename "$PRIMEIRO") ---"
    grep -nE '^\s*(vip_status_e|vip_status_t|VIP_API|vip_.*\()' "$PRIMEIRO" 2>/dev/null | head -40 | sed 's/^/    /'
else
    aviso "Nenhum header vip_*.h — instale o ai-sdk para obter vip_lite.h."
fi

# ── Ferramenta de validação ───────────────────────────────────────
titulo "vpm_run (validador de NBG)"
if command -v vpm_run >/dev/null 2>&1; then
    ok "vpm_run em $(command -v vpm_run)"
    echo "  --- versão ---"
    vpm_run --version 2>&1 | head -5 | sed 's/^/    /'
    echo "  --- uso ---"
    # As flags variam por versao do SDK; capturar o help evita supor a CLI.
    vpm_run --help 2>&1 | head -25 | sed 's/^/    /'
else
    aviso "vpm_run não instalado — é o caminho mais rápido de validar um .nbg."
fi

# ── SDK ───────────────────────────────────────────────────────────
titulo "ai-sdk da Radxa"
for dir in ~/ai-sdk /opt/ai-sdk /usr/share/ai-sdk; do
    if [ -d "$dir" ]; then
        ok "$dir"
        ls "$dir" 2>/dev/null | head -10 | sed 's/^/      /'
    fi
done
[ -d ~/ai-sdk ] || [ -d /opt/ai-sdk ] || aviso "ai-sdk não encontrado. Clone e compile:"
[ -d ~/ai-sdk ] || [ -d /opt/ai-sdk ] || echo "      git clone https://github.com/ZIFENG278/ai-sdk.git"
[ -d ~/ai-sdk ] || [ -d /opt/ai-sdk ] || echo "      make AI_SDK_PLATFORM=a733 NPU_SW_VERSION=v2.0"

# ── Modelo compilado ──────────────────────────────────────────────
titulo "Modelos NBG no projeto"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NBGS=$(find "$RAIZ" -name '*.nbg' 2>/dev/null)
if [ -n "$NBGS" ]; then
    ok "NBG presentes:"
    echo "$NBGS" | while read -r m; do
        printf "      %s (%s)\n" "$m" "$(du -h "$m" 2>/dev/null | cut -f1)"
    done
else
    aviso "Nenhum .nbg — o modelo ainda não foi compilado para a NPU."
    aviso "Pipeline: npu_compilation/export_onnx.py → acuity_export_yolo.sh"
fi
echo "  POSE_MODEL_PATH atual: ${POSE_MODEL_PATH:-(não definido — CPU)}"

# ── Térmica ───────────────────────────────────────────────────────
titulo "Temperatura"
# A NPU reduz clock sob calor; num appliance fechado numa loja isso e comum e
# aparece como queda de FPS sem erro nenhum no log.
for zona in /sys/class/thermal/thermal_zone*/temp; do
    [ -r "$zona" ] || continue
    nome=$(cat "$(dirname "$zona")/type" 2>/dev/null || echo "?")
    valor=$(cat "$zona" 2>/dev/null)
    printf "  %-20s %s°C\n" "$nome" "$((valor / 1000))"
done

echo
echo "=========================================================="
echo "  Cole esta saída inteira — é ela que permite escrever o"
echo "  binding VIPLite sem adivinhar assinaturas."
echo "=========================================================="
