#!/bin/bash
# ==============================================================================
# Volta o appliance para uma versão anterior.
#
# Roda NO RADXA, não na máquina de desenvolvimento.
#
# Uso:
#   ./scripts/rollback.sh              # volta para a versão imediatamente anterior
#   ./scripts/rollback.sh v1.1.0       # volta para uma versão específica
#   ./scripts/rollback.sh --listar     # mostra as versões disponíveis
# ==============================================================================

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

ARQUIVO_ENV=".env"
ALVO="${1:-}"

versao_atual() {
    if [ -f "$ARQUIVO_ENV" ] && grep -q '^VISIONCAM_TAG=' "$ARQUIVO_ENV"; then
        grep '^VISIONCAM_TAG=' "$ARQUIVO_ENV" | cut -d= -f2
    else
        echo "latest"
    fi
}

if [ "$ALVO" = "--listar" ]; then
    echo "Versão em uso: $(versao_atual)"
    echo
    echo "Disponíveis:"
    git tag -l 'v*' --sort=-v:refname | head -15
    exit 0
fi

ATUAL="$(versao_atual)"

if [ -z "$ALVO" ]; then
    # Uma abaixo da atual na ordenação semântica. Se a atual for "latest", não
    # dá para saber o que veio antes — daí a exigência de informar.
    if [ "$ATUAL" = "latest" ]; then
        echo "ERRO: a versão em uso é 'latest', que não tem antecessora definida."
        echo "      Informe explicitamente:  ./scripts/rollback.sh vX.Y.Z"
        echo
        git tag -l 'v*' --sort=-v:refname | head -10
        exit 1
    fi
    ALVO="$(git tag -l 'v*' --sort=-v:refname | grep -A1 "^${ATUAL}$" | tail -1)"
    if [ -z "$ALVO" ] || [ "$ALVO" = "$ATUAL" ]; then
        echo "ERRO: não há versão anterior a ${ATUAL}."
        exit 1
    fi
fi

if ! git rev-parse "$ALVO" >/dev/null 2>&1; then
    echo "ERRO: versão ${ALVO} não existe."
    git tag -l 'v*' --sort=-v:refname | head -10
    exit 1
fi

echo "=========================================================="
echo "  ROLLBACK"
echo "=========================================================="
echo "  De : ${ATUAL}"
echo "  Para: ${ALVO}"
echo "=========================================================="
read -r -p "Confirma? [s/N] " resposta
case "$resposta" in
    [sS]) ;;
    *) echo "Cancelado."; exit 0 ;;
esac

# Preserva as demais variáveis do .env — TZ, CLOUD_API_URL e o caminho do
# modelo da NPU moram aqui e não têm relação com a versão.
if [ -f "$ARQUIVO_ENV" ]; then
    grep -v '^VISIONCAM_TAG=' "$ARQUIVO_ENV" > "${ARQUIVO_ENV}.tmp" || true
    mv "${ARQUIVO_ENV}.tmp" "$ARQUIVO_ENV"
fi
echo "VISIONCAM_TAG=${ALVO}" >> "$ARQUIVO_ENV"

echo
echo "==> Baixando imagens da versão ${ALVO}..."
docker compose pull

echo "==> Subindo..."
docker compose up -d

echo
echo "=========================================================="
echo "  Rollback para ${ALVO} concluído."
echo "=========================================================="
echo "  Confirme antes de sair:"
echo "    docker compose ps"
echo "    curl -s localhost:8000/api/engine/status"
echo
echo "  O banco NÃO foi revertido. Se a versão nova tiver migrado o schema,"
echo "  a antiga pode não entender os dados — verifique antes de assumir que"
echo "  o rollback resolveu."
echo "=========================================================="
