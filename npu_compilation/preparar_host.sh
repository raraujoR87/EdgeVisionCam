#!/bin/bash
# ==============================================================================
# Prepara o PC x86 para compilar modelos para a NPU.
#
# Verifica (e instala, quando possivel) o que a compilacao exige, e explica o
# que precisa vir do fabricante. A imagem do ACUITY NAO esta no Docker Hub: e um
# download de ~11 GB da Allwinner, e descobrir isso no meio do processo custa
# uma tarde.
#
# Uso:  bash npu_compilation/preparar_host.sh
#       INSTALAR_DOCKER=1 bash npu_compilation/preparar_host.sh
# ==============================================================================

set -uo pipefail

IMAGEM="${IMAGEM:-ubuntu-npu:v2.0.10.1}"
URL_IMAGEM="https://netstorage.allwinnertech.com:5001/fsdownload/Mh23BhPHq/docker_images_v2.0.x.zip"
INSTALAR_DOCKER="${INSTALAR_DOCKER:-0}"

titulo(){ printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso() { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo "=========================================================="
echo "  PREPARAÇÃO DO HOST DE COMPILAÇÃO (x86)"
echo "=========================================================="

# ── Arquitetura ───────────────────────────────────────────────────
titulo "Arquitetura"
ARCH="$(uname -m)"
echo "  uname -m : $ARCH"
case "$ARCH" in
    x86_64|amd64) ok "Compatível — o ACUITY é x86-only." ;;
    aarch64|arm64)
        erro "Host ARM. O container do ACUITY não roda aqui."
        erro "A compilação precisa de um PC x86 (Linux, ou Windows com WSL2)."
        exit 1 ;;
    *) aviso "Arquitetura $ARCH — provavelmente incompatível." ;;
esac

# ── Espaço em disco ───────────────────────────────────────────────
titulo "Espaço em disco"
# ~11 GB do zip + ~11 GB extraidos + ~15 GB da imagem carregada. Ficar sem
# espaco no meio do `docker load` deixa a imagem pela metade, e o erro nao diz
# que a causa foi disco.
LIVRE_GB=$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9')
echo "  Livre: ${LIVRE_GB:-?} GB"
if [ -n "${LIVRE_GB:-}" ] && [ "$LIVRE_GB" -lt 40 ]; then
    aviso "Menos de 40 GB. O processo precisa de ~35 GB no pico:"
    aviso "  zip 11 GB + extraído 11 GB + imagem carregada ~15 GB."
    aviso "Você pode apagar o zip e o .tar depois do 'docker load'."
else
    ok "Espaço suficiente."
fi

# ── Docker ────────────────────────────────────────────────────────
titulo "Docker"
if command -v docker >/dev/null 2>&1; then
    ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
elif [ "$INSTALAR_DOCKER" = "1" ]; then
    echo "  Instalando via get.docker.com..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
    sudo usermod -aG docker "$USER"
    ok "Docker instalado."
    aviso "Saia e entre na sessão (ou rode 'newgrp docker') para usar sem sudo."
else
    erro "Docker não instalado."
    echo "  Instale com um destes:"
    echo "    INSTALAR_DOCKER=1 bash npu_compilation/preparar_host.sh"
    echo "    curl -fsSL https://get.docker.com | sudo sh"
    echo "    (Windows/macOS: Docker Desktop)"
    exit 1
fi

if docker info >/dev/null 2>&1; then
    ok "Daemon acessível."
else
    aviso "Sem permissão no daemon. Rode 'newgrp docker' ou use sudo."
fi

# ── Imagem do ACUITY ──────────────────────────────────────────────
titulo "Imagem do ACUITY"
if docker image inspect "$IMAGEM" >/dev/null 2>&1; then
    ok "$IMAGEM já carregada"
    echo "  Verificando o pegasus dentro dela..."
    if docker run --rm "$IMAGEM" bash -c 'ls /root/acuity-toolkit-whl-*/bin/pegasus* 2>/dev/null' | head -3 | sed 's/^/    /'; then
        ok "ACUITY presente."
    else
        aviso "pegasus não encontrado no caminho esperado — verifique a imagem."
    fi
else
    erro "$IMAGEM não está carregada."
    echo
    echo "  Esta imagem NÃO está no Docker Hub. Vem da Allwinner:"
    echo
    echo "    $URL_IMAGEM"
    echo "    (~11 GB, contém ubuntu-npu:v2.0.10.1 com ACUITY 6.30.22)"
    echo
    echo "  Depois de baixar:"
    echo "    unzip docker_images_v2.0.x.zip"
    echo "    docker load < ubuntu-npu-v2.0.10.1.tar"
    echo
    echo "  Confira com:"
    echo "    docker run --rm $IMAGEM bash -c 'ls /root/acuity-toolkit-whl-*/bin'"
    echo
    aviso "Sem esta imagem não há compilação — o ACUITY é proprietário e"
    aviso "não tem substituto aberto para o formato NBG."
fi

# ── Python do lado do host ────────────────────────────────────────
titulo "Dependências do host"
# export_onnx.py e prepare_calibration.py rodam FORA do container.
for pacote in ultralytics onnx cv2; do
    if python3 -c "import $pacote" 2>/dev/null; then
        ok "python3: $pacote"
    else
        aviso "python3: $pacote ausente — necessário para export_onnx.py"
    fi
done
echo "  Instale o que faltar com:"
echo "    pip install ultralytics onnx onnxruntime opencv-python"

# ── Resumo ────────────────────────────────────────────────────────
echo
echo "=========================================================="
if docker image inspect "$IMAGEM" >/dev/null 2>&1; then
    echo "  HOST PRONTO"
    echo "=========================================================="
    echo "  python3 npu_compilation/export_onnx.py"
    echo "  python3 npu_compilation/prepare_calibration.py"
    echo "  bash    npu_compilation/compilar_nbg.sh"
else
    echo "  FALTA A IMAGEM DO ACUITY"
    echo "=========================================================="
    echo "  Baixe, carregue com 'docker load' e rode este script de novo."
fi
echo "=========================================================="
