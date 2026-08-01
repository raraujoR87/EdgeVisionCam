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
# O WSL2 e um host x86 normal para efeito do Docker: vale a pena dizer isso em
# voz alta, porque "preciso de Linux" costuma ser lido como "preciso de outra
# maquina" quando o PC Windows ja serve.
if grep -qi microsoft /proc/version 2>/dev/null; then
    ok "Rodando sob WSL2 — o Docker Desktop expõe o daemon aqui normalmente."
fi
case "$ARCH" in
    x86_64|amd64) ok "Compatível — o ACUITY é x86-only." ;;
    aarch64|arm64)
        erro "Host ARM. O container do ACUITY é x86-only e não roda aqui."
        echo
        echo "  Emular x86 com QEMU é possível, mas não compensa:"
        echo "    - 5 a 20x mais lento, e a quantização já é pesada;"
        echo "    - o ACUITY é baseado em TensorFlow e não cabe confortavelmente"
        echo "      nos 4 GB da placa, ainda mais com a stack de produção no ar;"
        echo "    - ~15 GB de imagem no armazenamento do appliance."
        echo
        echo "  Use um PC x86. Se ele for Windows, o caminho é o WSL2:"
        echo "    wsl --install                    (PowerShell como administrador)"
        echo "    instale o Docker Desktop e ative a integração com o WSL"
        echo "    abra o Ubuntu e rode este script de dentro dele"
        echo
        echo "  Detalhes: npu_compilation/README.md, seção 'Compilando no Windows'."
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
# `command -v docker` nao basta no WSL: o Docker Desktop instala um shim que
# existe no PATH mesmo com a integracao desligada, e ele responde a qualquer
# invocacao com um texto de ajuda. Testar so a presenca do binario reporta
# "Docker OK" numa distro onde nenhum container sobe.
VERSAO_DOCKER="$(docker --version 2>&1 || true)"

if echo "$VERSAO_DOCKER" | grep -qi "could not be found in this WSL"; then
    erro "O Docker Desktop não está integrado a esta distro do WSL."
    echo
    echo "  O comando 'docker' aqui é só um atalho do Docker Desktop; ele"
    echo "  responde com instruções em vez de falar com o daemon."
    echo
    echo "  No Windows: Docker Desktop → Settings → Resources → WSL Integration"
    echo "    1. ative 'Enable integration with my default WSL distro', ou"
    echo "    2. ligue a chave da distro que você usa (Ubuntu)"
    echo "    3. Apply & Restart"
    echo
    echo "  Feche e reabra este terminal, depois rode este script de novo."
    exit 1
fi

if command -v docker >/dev/null 2>&1 && echo "$VERSAO_DOCKER" | grep -qiE '^Docker version'; then
    ok "$(echo "$VERSAO_DOCKER" | cut -d, -f1)"
elif command -v docker >/dev/null 2>&1; then
    # Binario presente, resposta inesperada: mostrar a saida crua e melhor do
    # que traduzi-la em "OK" ou num erro generico.
    erro "'docker' existe mas não respondeu como esperado:"
    echo "$VERSAO_DOCKER" | head -5 | sed 's/^/    /'
    exit 1
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
FALTANDO_PY=0
for pacote in ultralytics onnx onnxruntime cv2; do
    if python3 -c "import $pacote" 2>/dev/null; then
        ok "python3: $pacote"
    else
        aviso "python3: $pacote ausente"
        FALTANDO_PY=1
    fi
done

if [ "$FALTANDO_PY" = "1" ]; then
    echo
    # Numa distro limpa do WSL o pip nem existe, e o erro que aparece
    # ("pip: command not found") nao diz qual pacote instalar.
    if ! command -v pip3 >/dev/null 2>&1 && ! python3 -m pip --version >/dev/null 2>&1; then
        echo "  O pip não está instalado. No Ubuntu do WSL:"
        echo "    sudo apt update && sudo apt install -y python3-pip python3-venv"
        echo
    fi
    echo "  Depois, num ambiente isolado (o Debian/Ubuntu recente recusa"
    echo "  instalar no Python do sistema):"
    echo "    python3 -m venv ~/.venv-visioncam"
    echo "    source ~/.venv-visioncam/bin/activate"
    echo "    pip install ultralytics onnx onnxruntime opencv-python-headless"
    echo
    echo "  O ultralytics traz o PyTorch junto — cerca de 2 GB de download."
    echo "  Use 'opencv-python-headless': a variante completa puxa bibliotecas"
    echo "  de interface gráfica que não existem no WSL."
    echo
    echo "  Reative o venv sempre que abrir um terminal novo:"
    echo "    source ~/.venv-visioncam/bin/activate"
fi

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
