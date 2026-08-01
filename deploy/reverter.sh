#!/bin/bash
# ==============================================================================
# Volta o appliance para as imagens anteriores ao último deploy/atualizar.sh.
#
# Existe porque a alternativa, num appliance em produção, é reconstruir a partir
# de um commit antigo — o que leva minutos com a loja sem detecção, e depende de
# alguém acertar qual commit estava rodando. As imagens marcadas :pre-upgrade
# tornam a volta imediata e determinística.
#
# Chamado automaticamente por atualizar.sh quando a verificação de saúde falha,
# e disponível para rodar à mão quando o problema aparece depois — degradação de
# acurácia, por exemplo, que nenhum healthcheck pega.
#
# Uso:  bash deploy/reverter.sh
# ==============================================================================

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 1

TAG_ROLLBACK="pre-upgrade"
SERVICOS_VERSIONADOS=(visioncam-core visioncam-ui)

ok()    { printf "  \033[32m✓\033[0m %s\n" "$1"; }
erro()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

printf "\n\033[1m==> Revertendo para as imagens :%s\033[0m\n" "$TAG_ROLLBACK"

# A tag alvo precisa ser a mesma que o compose resolve, senão o 'up' recria os
# containers a partir da imagem nova de novo e a reversão não tem efeito.
TAG_ATUAL="latest"
if [ -f .env ]; then
    DO_ENV="$(grep -E '^VISIONCAM_TAG=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
    [ -n "${DO_ENV:-}" ] && TAG_ATUAL="$DO_ENV"
fi

FALTANDO=0
for servico in "${SERVICOS_VERSIONADOS[@]}"; do
    if ! docker image inspect "raphael7araujo/${servico}:${TAG_ROLLBACK}" >/dev/null 2>&1; then
        erro "Imagem raphael7araujo/${servico}:${TAG_ROLLBACK} não existe."
        FALTANDO=1
    fi
done

if [ "$FALTANDO" = "1" ]; then
    erro "Não há ponto de retorno — atualizar.sh não chegou a marcar as imagens."
    echo "  Reconstrua a partir do commit anterior:"
    echo "    git checkout <commit-anterior> && bash deploy/atualizar.sh"
    exit 1
fi

for servico in "${SERVICOS_VERSIONADOS[@]}"; do
    docker tag "raphael7araujo/${servico}:${TAG_ROLLBACK}" \
               "raphael7araujo/${servico}:${TAG_ATUAL}" || exit 1
    ok "${servico}:${TAG_ATUAL} ← :${TAG_ROLLBACK}"
done

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.hardware.yml ] && COMPOSE+=(-f docker-compose.hardware.yml)
[ -f docker-compose.mgmt.yml ] && COMPOSE+=(-f docker-compose.mgmt.yml)
# O override de build entra para que o pull_policy: never valha: sem ele o
# Compose tentaria baixar a tag do registro e sobrescreveria justamente a
# imagem que acabamos de restaurar.
COMPOSE+=(-f docker-compose.build.yml)

printf "\n\033[1m==> Recriando os containers\033[0m\n"
if ! "${COMPOSE[@]}" up -d --force-recreate; then
    erro "Falha ao recriar os containers."
    exit 1
fi

printf "\n"
"${COMPOSE[@]}" ps 2>/dev/null | sed 's/^/  /'
printf "\n  Reversão concluída.\n\n"
