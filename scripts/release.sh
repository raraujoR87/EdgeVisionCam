#!/bin/bash
# ==============================================================================
# Publica uma versão do VisionCam e registra qual está no ar em cada appliance.
#
# O stack usava `:latest` nas duas imagens, o que torna rollback impossível:
# sem saber qual build está rodando, não há para onde voltar, e um `pull` numa
# loja pode trazer código diferente do de outra loja feito no mesmo dia.
#
# Uso:
#   ./scripts/release.sh v1.2.0            # constrói, publica e marca no git
#   DRY_RUN=1 ./scripts/release.sh v1.2.0  # só mostra o que faria
# ==============================================================================

set -euo pipefail

VERSAO="${1:-}"
REGISTRO="${REGISTRO:-raphael7araujo}"
DRY_RUN="${DRY_RUN:-0}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

if [ -z "$VERSAO" ]; then
    echo "Uso: ./scripts/release.sh vX.Y.Z"
    echo
    echo "Versões já publicadas:"
    git tag -l 'v*' --sort=-v:refname | head -10
    exit 1
fi

# Versão semântica, para que a ordenação por tag seja confiável na hora de
# descobrir "qual era a anterior" durante um rollback.
if ! [[ "$VERSAO" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERRO: versão deve seguir vX.Y.Z (ex.: v1.2.0). Recebido: $VERSAO"
    exit 1
fi

if git rev-parse "$VERSAO" >/dev/null 2>&1; then
    echo "ERRO: a tag $VERSAO já existe. Publicar duas imagens diferentes com a"
    echo "      mesma versão faz o rollback apontar para código imprevisível."
    exit 1
fi

# Árvore suja vira imagem que não corresponde a nenhum commit — e aí o que está
# na loja não existe no histórico.
if [ -n "$(git status --porcelain)" ]; then
    echo "ERRO: há alterações não commitadas. A imagem precisa corresponder"
    echo "      exatamente a um commit para que o rollback seja rastreável."
    git status --short
    exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"

echo "=========================================================="
echo "  RELEASE ${VERSAO}"
echo "=========================================================="
echo "  Commit    : ${COMMIT}"
echo "  Registro  : ${REGISTRO}"
echo "=========================================================="

if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY RUN] Construiria e publicaria as imagens :${VERSAO}"
    echo "[DRY RUN] Criaria a tag git ${VERSAO}"
    exit 0
fi

echo
echo "==> Rodando a suíte antes de publicar..."
python -m pytest -q

echo
echo "==> Construindo e publicando imagens multi-arquitetura..."
./scripts/build_and_push.sh "$VERSAO"

echo
echo "==> Marcando o commit..."
git tag -a "$VERSAO" -m "Release ${VERSAO}"
git push origin "$VERSAO"

echo
echo "=========================================================="
echo "  ${VERSAO} PUBLICADA"
echo "=========================================================="
echo "  Para atualizar uma loja:"
echo "    ssh radxa@IP"
echo "    cd ~/EdgeVisionCam"
echo "    echo 'VISIONCAM_TAG=${VERSAO}' > .env"
echo "    docker compose pull && docker compose up -d"
echo
echo "  Atualize UMA loja primeiro e observe por 24h antes das demais."
echo "  Para voltar:  ./scripts/rollback.sh"
echo "=========================================================="
