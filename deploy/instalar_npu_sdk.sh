#!/bin/bash
# ==============================================================================
# Instala o runtime VIPLite na placa, habilitando a NPU.
#
# O diagnostico desta placa mostrou o cenario mais favoravel possivel: o driver
# de kernel JA ESTA carregado (/dev/vipcore, modulo `vipcore`), com a
# npu_thermal_zone reportando temperatura. O que falta e inteiramente
# userspace — as bibliotecas VIPLite, que nao vem na imagem do sistema.
#
# Isso importa porque o driver e a parte que dependeria do fabricante: sem ele,
# a saida seria trocar a imagem do sistema. Com ele, e so copiar arquivos.
#
# O ai-sdk traz as bibliotecas ja compiladas para aarch64 — nao ha build, o
# `make` do repositorio serve para os exemplos.
#
# Uso:  bash deploy/instalar_npu_sdk.sh
#       SDK_DIR=/opt/ai-sdk bash deploy/instalar_npu_sdk.sh
# ==============================================================================

set -uo pipefail

SDK_DIR="${SDK_DIR:-$HOME/ai-sdk}"
SDK_REPO="${SDK_REPO:-https://github.com/ZIFENG278/ai-sdk.git}"
# v2.0 e a versao do driver desta placa. Um NBG compilado por um ACUITY de
# versao diferente e recusado no carregamento, com mensagem que nao indica que
# a causa e incompatibilidade de versao.
VERSAO="${VERSAO:-v2.0}"
ABI="${ABI:-aarch64-none-linux-gnu}"
DESTINO_LIB="${DESTINO_LIB:-/usr/local/lib/viplite}"
DESTINO_INC="${DESTINO_INC:-/usr/local/include/viplite}"

titulo() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()     { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso()  { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()   { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# ── Pré-condição: o driver ────────────────────────────────────────
titulo "Verificando o driver da NPU"
if [ ! -e /dev/vipcore ]; then
    erro "/dev/vipcore ausente — sem o driver de kernel não adianta instalar"
    erro "o userspace. Rode 'bash deploy/npu_diagnostico.sh' antes."
    exit 1
fi
ok "/dev/vipcore presente"
grep -E '^(vipcore|sunxi_npu)' /proc/modules 2>/dev/null | sed 's/^/    /'

# ── Obtenção do SDK ───────────────────────────────────────────────
titulo "Obtendo o ai-sdk"
if [ -d "$SDK_DIR/.git" ]; then
    ok "Já existe em $SDK_DIR"
    git -C "$SDK_DIR" pull --ff-only 2>&1 | sed 's/^/    /' || \
        aviso "Não foi possível atualizar; seguindo com a cópia local."
else
    echo "  Clonando (~500 MB, pode demorar)..."
    # --depth 1: o historico nao serve para nada aqui e triplica o download
    # num appliance que pode estar em link de loja.
    if ! git clone --depth 1 "$SDK_REPO" "$SDK_DIR" 2>&1 | tail -3 | sed 's/^/    /'; then
        erro "Falha ao clonar o SDK."
        exit 1
    fi
    ok "Clonado em $SDK_DIR"
fi

ORIGEM="$SDK_DIR/viplite-tina/lib/$ABI/$VERSAO"
if [ ! -d "$ORIGEM" ]; then
    erro "$ORIGEM não existe."
    echo "  Versões disponíveis:"
    ls "$SDK_DIR/viplite-tina/lib/$ABI" 2>/dev/null | sed 's/^/      /'
    exit 1
fi
ok "Runtime encontrado: $ORIGEM"

# ── Instalação ────────────────────────────────────────────────────
titulo "Instalando bibliotecas e headers"
SUDO=""
[ "$EUID" -ne 0 ] && SUDO="sudo"

$SUDO mkdir -p "$DESTINO_LIB" "$DESTINO_INC"
# Só as .so do diretório raiz: as de debug/ são builds instrumentados, muito
# mais lentos, e misturá-las torna imprevisível qual o loader escolhe.
$SUDO cp -v "$ORIGEM"/*.so "$DESTINO_LIB/" 2>/dev/null | sed 's/^/    /'
$SUDO cp -v "$ORIGEM"/inc/*.h "$DESTINO_INC/" 2>/dev/null | sed 's/^/    /'

INSTALADAS=$(ls "$DESTINO_LIB"/*.so 2>/dev/null | wc -l)
if [ "$INSTALADAS" -eq 0 ]; then
    erro "Nenhuma biblioteca copiada."
    exit 1
fi
ok "$INSTALADAS bibliotecas em $DESTINO_LIB"

# ── Registro no loader ────────────────────────────────────────────
# ldconfig e mais confiavel que LD_LIBRARY_PATH: vale para todo processo,
# inclusive os que o systemd inicia sem herdar o ambiente do shell — que e
# exatamente o caso do appliance.
titulo "Registrando no loader dinâmico"
echo "$DESTINO_LIB" | $SUDO tee /etc/ld.so.conf.d/viplite.conf >/dev/null
$SUDO ldconfig
if ldconfig -p | grep -q VIPhal; then
    ok "libVIPhal.so visível para o loader"
else
    aviso "libVIPhal.so não aparece em 'ldconfig -p'. Verifique $DESTINO_LIB."
fi

# ── Verificação ───────────────────────────────────────────────────
titulo "Verificando o carregamento"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 1
python3 - <<'PY'
import sys
sys.path.insert(0, ".")
from edge import viplite

disponivel, motivo = viplite.disponivel()
print(f"  disponivel: {disponivel}")
print(f"  motivo    : {motivo}")
if disponivel:
    try:
        viplite.carregar_biblioteca()
        print("  libVIPhal.so carregou com sucesso.")
    except Exception as erro:
        print(f"  ERRO ao carregar: {erro}")
        sys.exit(1)
else:
    sys.exit(1)
PY
RESULTADO=$?

echo
if [ "$RESULTADO" -eq 0 ]; then
    echo "=========================================================="
    echo "  RUNTIME VIPLITE INSTALADO"
    echo "=========================================================="
    echo "  Falta o modelo. A NPU não executa .pt nem .onnx — só NBG:"
    echo
    echo "    1. No PC x86 (não aqui — o ACUITY é x86-only):"
    echo "       bash    npu_compilation/preparar_host.sh"
    echo "       python3 npu_compilation/export_onnx.py"
    echo "       python3 npu_compilation/prepare_calibration.py"
    echo "       bash    npu_compilation/compilar_nbg.sh"
    echo
    echo "    2. Copie o .nb para edge/ nesta placa e valide isolado:"
    echo "       vpm_run edge/yolov8n-pose.nb"
    echo
    echo "    3. Só então aponte a engine:"
    echo "       POSE_MODEL_PATH=edge/yolov8n-pose.nb"
    echo
    echo "  Detalhes: npu_compilation/README.md"
    echo "=========================================================="
else
    erro "O runtime não ficou utilizável. Rode: bash deploy/npu_diagnostico.sh"
    exit 1
fi
