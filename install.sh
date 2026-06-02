#!/bin/bash
# ==============================================================================
# Script de Instalação Um-Clique para Radxa Cubie A7A — VisionCam
# ==============================================================================

set -e

echo "=========================================================="
echo "    VISIONCAM: INSTALAÇÃO AUTOMÁTICA EM UM CLIQUE"
echo "=========================================================="

# 1. Verificar privilégios de root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Erro: Por favor, execute este script como root (usando sudo)."
  echo "Exemplo: sudo bash install.sh"
  exit 1
fi

# Detectar o usuário real (que executou o sudo) para ajustar permissões
ACTUAL_USER=${SUDO_USER:-$USER}
HOME_DIR=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)

echo "👤 Usuário do sistema detectado: $ACTUAL_USER"
echo "🏠 Pasta Home correspondente: $HOME_DIR"

# 2. Atualizar repositórios e instalar dependências base do Linux
echo "🔄 [1/4] Atualizando pacotes e instalando dependências base..."
apt-get update -y
apt-get install -y python3 python3-pip git curl network-manager

# 3. Instalar Docker Engine e Docker Compose (caso ausentes)
if ! command -v docker &> /dev/null; then
  echo "🐳 [2/4] Docker não encontrado. Instalando Docker Engine..."
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  rm get-docker.sh
else
  echo "🐳 [2/4] Docker já está instalado no sistema."
fi

# Adiciona o usuário do Radxa ao grupo docker para poder rodar comandos sem sudo
usermod -aG docker "$ACTUAL_USER"
echo "✅ Permissões do grupo Docker ajustadas para o usuário: $ACTUAL_USER"

# 4. Clonar o repositório da VisionCam do GitHub
INSTALL_DIR="${HOME_DIR}/EdgeVisionCam"
echo "📦 [3/4] Baixando código-fonte do GitHub em: ${INSTALL_DIR}..."

if [ -d "$INSTALL_DIR" ]; then
  echo "Diretório do projeto já existe. Atualizando código via Git..."
  cd "$INSTALL_DIR"
  # Reset local changes if any to prevent merge conflicts on clean deploy
  git fetch origin
  git reset --hard origin/main
else
  git clone https://github.com/raraujoR87/EdgeVisionCam.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Ajusta a propriedade dos arquivos para o usuário correto
chown -R "$ACTUAL_USER":"$ACTUAL_USER" "$INSTALL_DIR"

# 5. Efetuar o Deploy Automático das Imagens de Produção
echo "🚀 [4/4] Inicializando os serviços da VisionCam em modo Automático..."

# Inicializa variáveis padrão
MGMT_MODE="portainer-agent"  # Mantém comportamento original local/VPN por padrão
EDGE_KEY=""
EDGE_ID=""
DOCKER_USER=""
DOCKER_PASS=""

# Parse de argumentos passados para o script
while [[ $# -gt 0 ]]; do
  case $1 in
    --mgmt-mode)
      MGMT_MODE="$2"
      shift 2
      ;;
    --edge-key)
      EDGE_KEY="$2"
      shift 2
      ;;
    --edge-id)
      EDGE_ID="$2"
      shift 2
      ;;
    --user)
      DOCKER_USER="$2"
      shift 2
      ;;
    --pass)
      DOCKER_PASS="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Executa o instalador em modo autônomo (--auto) passando os argumentos correspondentes
python3 bootstrap_installer.py --auto \
  --mgmt-mode "$MGMT_MODE" \
  --edge-key "$EDGE_KEY" \
  --edge-id "$EDGE_ID" \
  --user "$DOCKER_USER" \
  --pass "$DOCKER_PASS"

echo "=========================================================="
echo " 🎉 SETUP COMPLETO! A stack da VisionCam está ONLINE!"
echo "=========================================================="
echo "• Dashboard Técnico: http://localhost:3000 (ou IP da placa)"
echo "• Status do Docker: Execute 'docker ps' no terminal"
echo "=========================================================="
