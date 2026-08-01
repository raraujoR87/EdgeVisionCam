#!/bin/bash
# ==============================================================================
# Prepara o Radxa para o fluxo de instalação em campo.
#
# Roda UMA VEZ, na bancada, antes de a placa ir para a loja. Depois disso o
# técnico só precisa plugar na rede, abrir o navegador e digitar o código.
#
# O que isto resolve:
#   - o instalador sobe sozinho no boot (senão alguém teria que dar SSH, o que
#     anularia o ganho do formulário web);
#   - a placa passa a atender por nome (visioncam.local), senão o técnico
#     precisaria descobrir o IP no roteador do cliente.
#
# Uso:  sudo bash deploy/preparar_appliance.sh
# ==============================================================================

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Rode como root: sudo bash deploy/preparar_appliance.sh"
    exit 1
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USUARIO="${SUDO_USER:-radxa}"
HOSTNAME_ALVO="${HOSTNAME_ALVO:-visioncam}"

echo "=========================================================="
echo "  PREPARAÇÃO DO APPLIANCE"
echo "=========================================================="
echo "  Diretório : ${RAIZ}"
echo "  Usuário   : ${USUARIO}"
echo "  Hostname  : ${HOSTNAME_ALVO}"
echo "=========================================================="

# ── 1. Descoberta na rede ─────────────────────────────────────────
# O mDNS faz a placa responder por visioncam.local em qualquer rede, sem DHCP
# reservado nem consulta ao roteador do cliente.
echo
echo "==> [1/4] Instalando descoberta na rede (mDNS)..."
apt-get update -qq
apt-get install -y -qq avahi-daemon avahi-utils python3 >/dev/null

hostnamectl set-hostname "$HOSTNAME_ALVO"
# O Avahi anuncia o hostname do sistema; sem a entrada em /etc/hosts, alguns
# utilitários demoram a resolver o próprio nome e atrasam o boot.
if ! grep -q "127.0.1.1.*${HOSTNAME_ALVO}" /etc/hosts; then
    echo "127.0.1.1    ${HOSTNAME_ALVO}" >> /etc/hosts
fi
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
echo "    A placa responderá em http://${HOSTNAME_ALVO}.local:8080"

# ── 2. Docker ─────────────────────────────────────────────────────
echo
echo "==> [2/4] Verificando Docker..."
if ! command -v docker >/dev/null 2>&1; then
    echo "    Instalando Docker Engine..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh >/dev/null
    rm -f /tmp/get-docker.sh
fi
usermod -aG docker "$USUARIO" 2>/dev/null || true
systemctl enable --now docker >/dev/null 2>&1 || true
echo "    Docker pronto."

# ── 3. Serviço do instalador ──────────────────────────────────────
echo
echo "==> [3/4] Registrando o instalador para subir no boot..."
SERVICO=/etc/systemd/system/visioncam-bootstrap.service
sed "s|/home/radxa/EdgeVisionCam|${RAIZ}|g" \
    "${RAIZ}/deploy/visioncam-bootstrap.service" > "$SERVICO"

systemctl daemon-reload
systemctl enable visioncam-bootstrap >/dev/null
systemctl restart visioncam-bootstrap
echo "    Serviço ativo."

# ── 4. Verificação ────────────────────────────────────────────────
echo
echo "==> [4/4] Conferindo..."
sleep 3
if curl -fsS -o /dev/null --max-time 10 http://localhost:8080/; then
    echo "    Instalador respondendo na porta 8080."
else
    echo "    AVISO: o instalador não respondeu. Verifique com:"
    echo "      journalctl -u visioncam-bootstrap -n 50"
fi

IP="$(hostname -I | awk '{print $1}')"

echo
echo "=========================================================="
echo "  APPLIANCE PRONTO PARA IR A CAMPO"
echo "=========================================================="
echo "  Na loja, o técnico deve:"
echo "    1. Ligar a placa na rede e na energia"
echo "    2. Abrir  http://${HOSTNAME_ALVO}.local:8080"
echo "       (se o .local não resolver, use  http://${IP}:8080)"
echo "    3. Digitar o código emitido no console e clicar em Instalar"
echo
echo "  Nenhuma credencial é digitada em campo — o código traz a loja,"
echo "  a versão e a gerência de containers."
echo "=========================================================="
