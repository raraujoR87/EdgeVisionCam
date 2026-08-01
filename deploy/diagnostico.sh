#!/bin/bash
# ==============================================================================
# Levantamento do appliance antes da instalação.
#
# Roda no Radxa e coleta, de uma vez, tudo que determina se a stack vai subir.
# A ideia é evitar o vai-e-vem de descobrir um problema por vez — cada ciclo
# de "roda isso e me diz" custa tempo com a placa na bancada.
#
# Uso:  bash deploy/diagnostico.sh
#       bash deploy/diagnostico.sh > diagnostico.txt   (para colar depois)
# ==============================================================================

set -uo pipefail   # sem -e: um comando ausente não pode abortar o levantamento

titulo() { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
ok()     { printf "  \033[32m✓\033[0m %s\n" "$1"; }
aviso()  { printf "  \033[33m!\033[0m %s\n" "$1"; }
erro()   { printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo "=========================================================="
echo "  DIAGNÓSTICO DO APPLIANCE VISIONCAM"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================================="

titulo "Identificação"
echo "  Hostname : $(hostname)"
echo "  Modelo   : $(cat /proc/device-tree/model 2>/dev/null | tr -d '\0' || echo 'desconhecido')"
echo "  Kernel   : $(uname -r)"
echo "  Distro   : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo '?')"

titulo "Arquitetura"
ARCH="$(uname -m)"
echo "  uname -m : $ARCH"
# As imagens publicadas são linux/arm64. Numa placa armv7 (32 bits) elas nem
# baixam, e o erro do Docker não deixa claro que a causa é a arquitetura.
case "$ARCH" in
    aarch64|arm64) ok "Compatível com as imagens arm64 publicadas." ;;
    x86_64)        aviso "Host x86 — útil para teste, mas não é o hardware alvo." ;;
    *)             erro "Arquitetura $ARCH sem imagem publicada." ;;
esac

titulo "Memória e armazenamento"
free -h 2>/dev/null | head -2
TOTAL_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
# Os mem_limit do compose base são calibrados para 4 GB. Em placa menor, o teto
# de 2 GB do visioncam-core fica acima da RAM física e nunca dispara: o processo
# consome a placa toda antes disso e o OOM killer derruba outro serviço.
if [ -n "${TOTAL_MB:-}" ] && [ "$TOTAL_MB" -lt 1800 ]; then
    aviso "RAM de ${TOTAL_MB}MB — abaixo do recomendado. O instalador aplicará o"
    aviso "perfil de memória 'mínimo', mas espere reinícios sob carga."
elif [ -n "${TOTAL_MB:-}" ] && [ "$TOTAL_MB" -lt 3500 ]; then
    ok "RAM de ${TOTAL_MB}MB — o instalador aplicará o perfil 'reduzido'."
else
    ok "RAM suficiente para os limites padrão."
fi
echo
df -h / 2>/dev/null | head -2
LIVRE_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
# As imagens somam vários GB; gravações consomem o resto ao longo dos dias.
if [ -n "${LIVRE_GB:-}" ] && [ "$LIVRE_GB" -lt 12 ]; then
    aviso "Apenas ${LIVRE_GB}GB livres. As imagens ocupam ~6GB e as gravações crescem."
else
    ok "Espaço em disco adequado."
fi

titulo "Aceleração de hardware"
# O compose não declara mais estes devices: edge_hardware.py gera um override
# só com o que a placa tem. A ausência não impede a instalação — degrada para
# CPU. O que importa aqui é registrar isso, senão a lentidão é atribuída a
# rede, câmera ou modelo.
# O node da NPU do A733 é /dev/vipcore (driver VIPLite, módulo sunxi_npu), e
# NÃO /dev/galcore. Procurar galcore reporta "NPU ausente" numa placa cuja NPU
# funciona — use deploy/npu_diagnostico.sh para o levantamento detalhado.
if [ -e /dev/vipcore ]; then
    ok "/dev/vipcore presente — driver VIPLite da NPU carregado."
else
    aviso "/dev/vipcore AUSENTE — a inferência roda na CPU."
    # Distinguir "módulo não existe" de "módulo existe e não foi carregado" é o
    # que separa 'sem solução' de 'um modprobe resolve'.
    if find "/lib/modules/$(uname -r)" -name '*sunxi_npu*' 2>/dev/null | grep -q .; then
        aviso "  O módulo EXISTE mas não está carregado: sudo modprobe sunxi_npu"
    else
        aviso "  Nenhum módulo sunxi_npu neste kernel."
    fi
    aviso "  Detalhes: bash deploy/npu_diagnostico.sh"
fi
if [ -d /dev/dri ]; then
    ok "/dev/dri presente ($(ls /dev/dri 2>/dev/null | tr '\n' ' '))"
else
    aviso "/dev/dri ausente — decode de vídeo por hardware indisponível."
fi

titulo "Docker"
if command -v docker >/dev/null 2>&1; then
    ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
    if docker compose version >/dev/null 2>&1; then
        ok "compose $(docker compose version --short 2>/dev/null)"
    else
        erro "'docker compose' (v2) ausente — o stack usa a sintaxe v2."
    fi
    if docker info >/dev/null 2>&1; then
        ok "Daemon acessível pelo usuário atual."
    else
        aviso "Sem permissão no daemon. Rode com sudo ou adicione o usuário ao grupo docker."
    fi
else
    erro "Docker não instalado. deploy/preparar_appliance.sh instala."
fi

titulo "Rede"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  IP local : ${IP:-nenhum}"
if ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
    ok "Conectividade IP."
else
    erro "Sem rota para a internet — o provisionamento e o pull de imagens falham."
fi
if getent hosts registry-1.docker.io >/dev/null 2>&1; then
    ok "DNS resolvendo o Docker Hub."
else
    erro "DNS não resolve registry-1.docker.io."
fi
if curl -fsS -o /dev/null --max-time 10 https://visioncam-cloud.vercel.app/login 2>/dev/null; then
    ok "Console de nuvem alcançável (provisionamento por código vai funcionar)."
else
    aviso "Console de nuvem inacessível — verifique proxy ou firewall da loja."
fi

titulo "Descoberta na rede (mDNS)"
if systemctl is-active --quiet avahi-daemon 2>/dev/null; then
    ok "avahi ativo — a placa deve responder como $(hostname).local"
else
    aviso "avahi inativo. Sem ele o técnico precisa descobrir o IP no roteador."
fi

titulo "Estado atual da stack"
# Precisa vir ANTES da checagem de portas: com a stack no ar, as portas
# aparecem ocupadas pelos próprios containers, o que não é conflito nenhum.
JA_INSTALADO=0
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    CONTAINERS=$(docker ps -a --filter "name=visioncam" --format '{{.Names}}\t{{.Status}}' 2>/dev/null)
    if [ -n "$CONTAINERS" ]; then
        echo "$CONTAINERS" | sed 's/^/  /'
        JA_INSTALADO=1
        echo
        aviso "Já existe uma instalação no ar. Isto é um UPGRADE, não uma"
        aviso "instalação limpa: subir o compose novo recria os containers e"
        aviso "derruba o serviço até as imagens novas estarem no lugar."
        aviso "Publique as imagens arm64 ANTES de rodar 'docker compose up -d'."
    else
        echo "  Nenhum container visioncam — instalação ainda não foi feita."
    fi
fi

titulo "Portas em uso"
# Conflito aqui aparece como container que sobe e morre, sem causa óbvia — mas
# só conta como conflito se quem ocupa a porta não for a própria stack.
CONFLITOS=0
for porta in 3000 5000 8000 8080 8554 1883; do
    if ss -lntH "sport = :$porta" 2>/dev/null | grep -q .; then
        if [ "$JA_INSTALADO" -eq 1 ]; then
            echo "  Porta $porta ocupada pela stack atual (esperado)."
        else
            aviso "Porta $porta ocupada por outro serviço — vai impedir a subida."
            CONFLITOS=$((CONFLITOS + 1))
        fi
    fi
done
if [ "$CONFLITOS" -eq 0 ]; then
    ok "Nenhum conflito de porta."
fi

echo
echo "=========================================================="
echo "  Cole esta saída inteira para análise."
echo "=========================================================="
