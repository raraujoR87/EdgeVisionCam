#!/bin/bash
# ==============================================================================
# Atualiza um appliance que JÁ ESTÁ EM PRODUÇÃO.
#
# bootstrap_installer.py é para instalação limpa: ele pressupõe que não há nada
# rodando e que uma falha custa apenas uma nova tentativa. Aqui a premissa é
# outra — existe um sistema no ar, e uma atualização que quebre deixa a loja
# sem detecção até alguém voltar lá.
#
# O que este script garante:
#   1. As imagens saem do commit que está no disco, não de uma :latest publicada
#      em outro momento. Compose novo com imagem velha é o modo mais silencioso
#      de quebrar: o container sobe, responde, e só a função que mudou falha.
#   2. As imagens em uso são marcadas antes de qualquer coisa, para que o
#      rollback não dependa de reconstruir nada.
#   3. Se a stack nova não passar na verificação de saúde, ela volta sozinha.
#      Um técnico não deveria precisar diagnosticar isso remotamente.
#
# Uso:  bash deploy/atualizar.sh
#       DRY_RUN=1 bash deploy/atualizar.sh    (mostra o plano, não executa)
# ==============================================================================

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 1

DRY_RUN="${DRY_RUN:-0}"
TAG_ROLLBACK="pre-upgrade"
SERVICOS_VERSIONADOS=(visioncam-core visioncam-ui)
ESPERA_MAX=180   # a primeira subida carrega os modelos YOLO; ~1 min é normal

titulo() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()     { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso()  { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()   { printf "  \033[31m✗\033[0m %s\n" "$1"; }

executar() {
    if [ "$DRY_RUN" = "1" ]; then
        printf "  [dry-run] %s\n" "$*"
        return 0
    fi
    "$@"
}

# ── Pré-condições ─────────────────────────────────────────────────
titulo "Verificando pré-condições"

if [ ! -f docker-compose.yml ]; then
    erro "docker-compose.yml não encontrado. Rode a partir do clone do repositório."
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    erro "Sem acesso ao daemon Docker. Use sudo ou adicione o usuário ao grupo docker."
    exit 1
fi
ok "Repositório e Docker acessíveis."

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'desconhecido')"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
ok "Construindo a partir de ${BRANCH} @ ${COMMIT}"

# Uma árvore suja significa que a imagem não corresponde a nenhum commit — o
# que inviabiliza reproduzir depois o que exatamente foi para a loja.
if [ -n "$(git status --porcelain 2>/dev/null | grep -v '^?? ')" ]; then
    aviso "Há alterações não commitadas. A imagem não corresponderá a ${COMMIT}."
fi

# ── Adequação ao hardware ─────────────────────────────────────────
titulo "Adequando o stack ao hardware desta placa"
if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] python3 -c 'edge_hardware.aplicar()'"
else
    python3 - <<'PY'
import sys
sys.path.insert(0, ".")
import edge_hardware

resumo = edge_hardware.aplicar()
for linha in edge_hardware.descrever(resumo):
    print(f"  {linha}")
PY
    if [ $? -ne 0 ]; then
        aviso "Falha ao gerar o override de hardware — seguindo com o compose base."
    fi
fi

# ── Montagem do comando do Compose ────────────────────────────────
# A ordem é a mesma de bootstrap_installer.compose_cmd(): base, hardware,
# gerência. Divergir aqui faria o upgrade produzir um stack diferente do que a
# instalação limpa produz, e a diferença só apareceria em campo.
COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.hardware.yml ] && COMPOSE+=(-f docker-compose.hardware.yml)
[ -f docker-compose.mgmt.yml ] && COMPOSE+=(-f docker-compose.mgmt.yml)

COMPOSE_BUILD=("${COMPOSE[@]}" -f docker-compose.build.yml)

# ── Marcação para rollback ────────────────────────────────────────
# Um único nível: rodar este script duas vezes faz o segundo ponto de retorno
# apontar para o resultado do primeiro upgrade, não para o estado original.
# Para voltar mais de um passo, reconstrua a partir do commit desejado.
titulo "Marcando as imagens em uso para rollback"
HA_ROLLBACK=0
for servico in "${SERVICOS_VERSIONADOS[@]}"; do
    # O container 'visioncam-ui' tem container_name 'visioncam-ui-local'.
    nome="$servico"
    [ "$servico" = "visioncam-ui" ] && nome="visioncam-ui-local"

    imagem_id="$(docker inspect --format '{{.Image}}' "$nome" 2>/dev/null)"
    if [ -z "$imagem_id" ]; then
        aviso "$nome não está rodando — nada a marcar."
        continue
    fi
    if executar docker tag "$imagem_id" "raphael7araujo/${servico}:${TAG_ROLLBACK}"; then
        ok "$nome → :${TAG_ROLLBACK}"
        HA_ROLLBACK=1
    fi
done

if [ "$HA_ROLLBACK" = "0" ]; then
    aviso "Nenhuma imagem anterior marcada. Sem rede de segurança para reverter."
fi

# ── Build ─────────────────────────────────────────────────────────
titulo "Construindo as imagens nesta placa (arm64 nativo)"
echo "  Isto leva alguns minutos. Os containers atuais seguem no ar até o 'up'."
if ! executar "${COMPOSE_BUILD[@]}" build; then
    erro "Build falhou. NADA foi alterado — a stack atual continua rodando."
    exit 1
fi
ok "Imagens construídas."

# ── Subida ────────────────────────────────────────────────────────
titulo "Subindo a stack nova"
if ! executar "${COMPOSE_BUILD[@]}" up -d --remove-orphans; then
    erro "Falha ao subir a stack."
    [ "$HA_ROLLBACK" = "1" ] && aviso "Reverta com: bash deploy/reverter.sh"
    exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
    titulo "Dry-run concluído"
    echo "  Nenhuma alteração foi feita."
    exit 0
fi

# ── Verificação de saúde ──────────────────────────────────────────
# Sem isto o script declararia sucesso assim que o Docker aceitasse o 'up' —
# que só diz que os containers foram criados, não que o sistema funciona.
titulo "Verificando a saúde da stack (até ${ESPERA_MAX}s)"

saudavel() {
    curl -fsS -o /dev/null --max-time 5 http://localhost:8000/api/engine/status 2>/dev/null &&
    curl -fsS -o /dev/null --max-time 5 http://localhost:5000/api/version 2>/dev/null
}

decorrido=0
while [ "$decorrido" -lt "$ESPERA_MAX" ]; do
    if saudavel; then
        ok "API e Frigate respondendo após ${decorrido}s."
        break
    fi
    sleep 5
    decorrido=$((decorrido + 5))
    printf "  aguardando... %ss\n" "$decorrido"
done

if ! saudavel; then
    erro "A stack não respondeu em ${ESPERA_MAX}s."
    "${COMPOSE_BUILD[@]}" ps 2>/dev/null | sed 's/^/  /'
    echo
    if [ "$HA_ROLLBACK" = "1" ]; then
        aviso "Revertendo automaticamente para as imagens anteriores..."
        if bash deploy/reverter.sh; then
            erro "Upgrade revertido. A stack anterior está de volta."
            echo "  Investigue com: docker compose logs --tail 100 visioncam-core"
            exit 1
        fi
        erro "O rollback também falhou. Intervenção manual necessária."
    fi
    exit 1
fi

# ── Confirmação do que mudou ──────────────────────────────────────
titulo "Estado final"
"${COMPOSE_BUILD[@]}" ps 2>/dev/null | sed 's/^/  /'

echo
# A inferência é o motivo de o appliance existir: containers no ar com a engine
# parada é justamente o estado que passa despercebido.
INFER="$(curl -fsS --max-time 5 http://localhost:8000/api/engine/status 2>/dev/null)"
if echo "$INFER" | grep -q 'inference_ms'; then
    ok "Engine reportando tempo de inferência."
else
    aviso "A engine não reporta inference_ms — o painel mostrará 'sem detectar'."
    aviso "Confira: docker compose logs --tail 50 visioncam-core"
fi

echo
echo "=========================================================="
echo "  ATUALIZADO — ${BRANCH} @ ${COMMIT}"
echo "=========================================================="
echo "  Console local : http://$(hostname -I | awk '{print $1}'):3000"
echo "  Reverter      : bash deploy/reverter.sh"
echo "=========================================================="
