#!/bin/bash
# ==============================================================================
# Constroi e publica as imagens do VisionCam para o Radxa Cubie A7A.
#
# O Radxa e ARM64. Nenhum dos Dockerfiles fixa plataforma, entao uma build
# feita numa maquina x86 sem buildx produz imagens que o appliance recusa a
# executar com "exec format error". Este script usa buildx para gerar as duas
# arquiteturas — arm64 para a placa, amd64 para testar no desktop.
#
# Uso:
#   ./scripts/build_and_push.sh                    # constroi e publica :latest
#   ./scripts/build_and_push.sh v1.2.0             # publica :v1.2.0 e :latest
#   PUSH=false ./scripts/build_and_push.sh         # so constroi, sem publicar
#   PLATFORMS=linux/arm64 ./scripts/build_and_push.sh   # so a placa (mais rapido)
# ==============================================================================

set -euo pipefail

REGISTRO="${REGISTRO:-raphael7araujo}"
TAG="${1:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-true}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

echo "=========================================================="
echo "  BUILD DAS IMAGENS VISIONCAM"
echo "=========================================================="
echo "  Registro   : ${REGISTRO}"
echo "  Tag        : ${TAG}"
echo "  Plataformas: ${PLATFORMS}"
echo "  Publicar   : ${PUSH}"
echo "=========================================================="

if ! docker buildx version >/dev/null 2>&1; then
    echo "ERRO: docker buildx não disponível."
    echo "Instale o plugin buildx ou use um Docker Desktop recente."
    exit 1
fi

# Um builder dedicado evita conflito com o contexto padrao, que em muitas
# instalacoes nao suporta multi-plataforma.
if ! docker buildx inspect visioncam-builder >/dev/null 2>&1; then
    echo "==> Criando builder 'visioncam-builder'..."
    docker buildx create --name visioncam-builder --driver docker-container --bootstrap
fi
docker buildx use visioncam-builder

# Emulacao para construir arm64 num host x86. Sem isso o build falha ao rodar
# comandos RUN da imagem arm64.
if [[ "$PLATFORMS" == *"arm64"* && "$(uname -m)" != "aarch64" ]]; then
    echo "==> Registrando emulação QEMU para arm64..."
    docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null 2>&1 || \
        echo "    (aviso: não foi possível registrar o QEMU; siga se já estiver configurado)"
fi

SAIDA="--push"
if [ "$PUSH" != "true" ]; then
    # Sem --push nem --load, o resultado ficaria só no cache do builder.
    SAIDA=""
    echo "==> Modo somente-build: as imagens ficarão no cache do buildx."
fi

construir() {
    local nome="$1" contexto="$2" dockerfile="$3"
    echo
    echo "==> Construindo ${REGISTRO}/${nome}:${TAG}..."
    docker buildx build \
        --platform "$PLATFORMS" \
        --file "$dockerfile" \
        --tag "${REGISTRO}/${nome}:${TAG}" \
        --tag "${REGISTRO}/${nome}:latest" \
        $SAIDA \
        "$contexto"
}

construir "visioncam-core" "." "Dockerfile"
construir "visioncam-ui"   "./ui" "./ui/Dockerfile"

echo
echo "=========================================================="
echo "  CONCLUÍDO"
echo "=========================================================="
if [ "$PUSH" = "true" ]; then
    echo "  Imagens publicadas:"
    echo "    ${REGISTRO}/visioncam-core:${TAG}"
    echo "    ${REGISTRO}/visioncam-ui:${TAG}"
    echo
    echo "  No Radxa, atualize a stack com:"
    echo "    cd ~/EdgeVisionCam && docker compose pull && docker compose up -d"
else
    echo "  Nada publicado (PUSH=false)."
fi
echo "=========================================================="
