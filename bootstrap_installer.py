import http.server
import socketserver
import json
import subprocess
import threading
import socket
import urllib.request
import os
import time

import edge_hardware
import edge_provisioning

PORT = 8080

# Thread-safe deployment state
deploy_state = {
    "is_deploying": False,
    "success": False,
    "error": None,
    "logs": []
}
logs_lock = threading.Lock()

def add_log(msg):
    with logs_lock:
        timestamp = time.strftime("%H:%M:%S")
        deploy_state["logs"].append(f"[{timestamp}] {msg}")
        print(f"[DEPLOY] {msg}")

def check_internet():
    try:
        # Tenta resolver o host do Docker Hub
        socket.gethostbyname("registry-1.docker.io")
        return True
    except socket.gaierror:
        return False

def check_docker():
    try:
        res = subprocess.run(["docker", "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        return res.stdout.strip() if res.returncode == 0 else None
    except Exception:
        return None

# Override gerado pelo instalador com o servico de gerencia escolhido. O stack
# base vive no docker-compose.yml versionado e nao e reescrito.
MGMT_OVERRIDE = "docker-compose.mgmt.yml"


def compose_cmd(*args):
    """
    Monta o comando do Compose incluindo os overrides existentes.

    A ordem importa: o Compose sobrepoe os arquivos na sequencia informada. O
    override de hardware vem antes do de gerencia porque descreve a placa, e o
    de gerencia apenas acrescenta um servico.
    """
    cmd = ["docker", "compose", "-f", "docker-compose.yml"]
    if os.path.exists(edge_hardware.ARQUIVO_OVERRIDE):
        cmd += ["-f", edge_hardware.ARQUIVO_OVERRIDE]
    if os.path.exists(MGMT_OVERRIDE):
        cmd += ["-f", MGMT_OVERRIDE]
    return cmd + list(args)


def check_docker_compose():
    try:
        res = subprocess.run(["docker", "compose", "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        return res.stdout.strip() if res.returncode == 0 else None
    except Exception:
        return None

def run_deployment_thread(username, password, mgmt_mode="none", edge_key="", edge_id="",
                          edge_insecure_poll=False, codigo="", cloud_url=""):
    global deploy_state
    deploy_state["is_deploying"] = True
    deploy_state["success"] = False
    deploy_state["error"] = None
    deploy_state["logs"] = []
    
    add_log("Iniciando processo de deploy automático no Radxa Cubie...")

    # 0. Provisionamento pela nuvem
    #
    # Quando o técnico informa um código, ele substitui tudo o que antes era
    # digitado à mão: chave da loja, versão alvo e Edge key vêm prontas da
    # nuvem. Isso roda antes de qualquer outra etapa porque um código inválido
    # deve falhar de imediato, não depois de baixar alguns GB de imagem.
    if codigo:
        add_log("Resgatando configuração da loja na nuvem...")
        try:
            config = edge_provisioning.resgatar(codigo, cloud_url or None)
        except edge_provisioning.ErroDeProvisionamento as erro:
            add_log(f"Provisionamento recusado: {erro}")
            deploy_state["is_deploying"] = False
            deploy_state["error"] = str(erro)
            return

        loja = config.get("store", {})
        deploy_cfg = config.get("deploy", {})

        # O código é de uso único: gravar antes de qualquer passo que possa
        # abortar evita que uma falha adiante exija emitir outro código.
        gravadas = edge_provisioning.gravar_env(config, cloud_url or None)

        add_log(f"Loja identificada: {loja.get('name', '(sem nome)')}")
        add_log(f"Versão alvo: {gravadas['VISIONCAM_TAG']}")

        # A nuvem decide o modo de gerência: sem Edge key não há Portainer
        # central, e subir um agente pela metade só geraria ruído no painel.
        mgmt_mode = deploy_cfg.get("mgmt_mode", "none")
        edge_key = deploy_cfg.get("edge_key", "") or edge_key
        if not edge_id:
            edge_id = loja.get("name", "") or edge_id
        add_log(f"Gerência de containers: {mgmt_mode}")

    # 1. Login Docker Hub
    if username and password:
        add_log(f"Autenticando no Docker Hub com o usuário: {username}...")
        try:
            # Executa docker login passando a senha via stdin para maior segurança
            proc = subprocess.Popen(
                ["docker", "login", "--username", username, "--password-stdin"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            stdout, stderr = proc.communicate(input=password)
            if proc.returncode != 0:
                add_log(f"Falha de autenticação: {stderr.strip()}")
                deploy_state["is_deploying"] = False
                deploy_state["error"] = "Erro de autenticação no Docker Hub."
                return
            add_log("Autenticação concluída com sucesso!")
        except Exception as e:
            add_log(f"Falha ao rodar docker login: {e}")
            deploy_state["is_deploying"] = False
            deploy_state["error"] = str(e)
            return
    else:
        add_log("Nenhuma credencial fornecida. Tentando baixar imagens públicas...")

    # 2. Escrever o override de gerência (o stack base vem do repositório)
    #
    # Este instalador antes carregava uma cópia inteira do docker-compose.yml
    # como f-string e sobrescrevia o arquivo do repositório. Eram duas
    # definições divergentes do mesmo stack: correções de limite de memória,
    # rotação de log ou healthcheck feitas no repositório nunca chegavam ao
    # appliance, porque o instalador as apagava no deploy seguinte.
    #
    # Agora o docker-compose.yml versionado é a única fonte, e daqui sai apenas
    # o serviço de gerência escolhido, num arquivo de override que o Compose
    # sobrepõe ao base.
    add_log("Preparando configuração de gerência de containers...")

    mgmt_service = ""
    if mgmt_mode == "portainer-agent":
        mgmt_service = """  portainer-agent:
    image: portainer/agent:latest
    container_name: visioncam-portainer-agent
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "9001:9001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
    networks:
      - visioncam
"""
    elif mgmt_mode == "portainer-edge-agent":
        if not edge_id:
            try:
                edge_id = f"edge-{socket.gethostname()}"
            except Exception:
                edge_id = "edge-device"
        # EDGE_INSECURE_POLL desliga a verificacao do certificado do servidor.
        # O canal de gerencia tem acesso ao socket Docker da loja, entao aceitar
        # qualquer certificado permite que um atacante interposto implante
        # containers arbitrarios no appliance. So e aceitavel enquanto o
        # Portainer estiver com certificado autoassinado; com o servidor de
        # portainer/docker-compose.yml (TLS via Let's Encrypt), deve ficar em 0.
        insecure_poll = "1" if edge_insecure_poll else "0"
        mgmt_service = f"""  portainer-edge-agent:
    image: portainer/edge-agent:latest
    container_name: visioncam-portainer-edge-agent
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    environment:
      - EDGE_KEY={edge_key}
      - EDGE_ID={edge_id}
      - EDGE_INSECURE_POLL={insecure_poll}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
    networks:
      - visioncam
"""

    if not os.path.exists("docker-compose.yml"):
        add_log("ERRO: docker-compose.yml não encontrado. Rode o instalador a partir do clone do repositório.")
        deploy_state["is_deploying"] = False
        deploy_state["error"] = "docker-compose.yml ausente."
        return

    if mgmt_service:
        try:
            with open(MGMT_OVERRIDE, "w", encoding="utf-8") as f:
                f.write("services:\n" + mgmt_service)
            add_log(f"Override de gerência gerado ({mgmt_mode}).")
        except Exception as e:
            add_log(f"Falha ao escrever {MGMT_OVERRIDE}: {e}")
            deploy_state["is_deploying"] = False
            deploy_state["error"] = f"Erro ao criar override: {e}"
            return
    else:
        # Sem modo de gerência: remove um override de instalação anterior para
        # que o agente não continue rodando por inércia.
        if os.path.exists(MGMT_OVERRIDE):
            os.remove(MGMT_OVERRIDE)
        add_log("Nenhum modo de gerência selecionado.")

    # 2a. Adequar o stack ao hardware desta placa
    #
    # Roda antes do pull porque define se o Frigate vai conseguir subir. Não é
    # motivo para abortar: sem NPU o sistema funciona na CPU, e é melhor
    # instalar degradado e registrar isso no log do que recusar a instalação
    # com o técnico na loja.
    add_log("Inspecionando o hardware da placa...")
    try:
        resumo_hw = edge_hardware.aplicar()
        for linha in edge_hardware.descrever(resumo_hw):
            add_log(linha)
    except Exception as e:
        add_log(f"Aviso: não foi possível adequar o stack ao hardware ({e}).")
        add_log("Seguindo com os limites padrão do docker-compose.yml.")

    # 2b. Escrever frigate_config.yml padrão se não existir
    if not os.path.exists("frigate_config.yml"):
        add_log("frigate_config.yml não encontrado. Gerando configuração padrão do NVR...")
        frigate_default = """mqtt:
  host: mqtt

cameras:
  camera_principal:
    enabled: true
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/live
          roles:
            - detect
            - record
    detect:
      enabled: true
      width: 640
      height: 480
      fps: 5
    record:
      enabled: true
      retain:
        days: 3
        mode: all
"""
        try:
            with open("frigate_config.yml", "w", encoding="utf-8") as f:
                f.write(frigate_default)
            add_log("Configuração frigate_config.yml padrão criada.")
        except Exception as e:
            add_log(f"Aviso: Não foi possível gerar frigate_config.yml: {e}")

    # 3. Baixar Imagens (docker compose pull)
    add_log("Iniciando download das imagens do Docker Hub (docker compose pull)...")
    try:
        proc = subprocess.Popen(
            compose_cmd("pull"),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        # Lê a saída em tempo real
        for line in proc.stdout:
            add_log(f"[Compose Pull] {line.strip()}")
        proc.wait()
        if proc.returncode != 0:
            add_log("Falha ao baixar as imagens.")
            deploy_state["is_deploying"] = False
            deploy_state["error"] = "Erro no download das imagens."
            return
        add_log("Todas as imagens foram baixadas com sucesso!")
    except Exception as e:
        add_log(f"Erro ao baixar imagens: {e}")
        deploy_state["is_deploying"] = False
        deploy_state["error"] = str(e)
        return

    # 4. Iniciar os Serviços (docker compose up -d)
    add_log("Subindo containers da stack (docker compose up -d)...")
    try:
        proc = subprocess.Popen(
            compose_cmd("up", "-d"),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        for line in proc.stdout:
            add_log(f"[Compose Up] {line.strip()}")
        proc.wait()
        if proc.returncode != 0:
            add_log("Falha ao subir a stack.")
            deploy_state["is_deploying"] = False
            deploy_state["error"] = "Erro ao rodar docker compose up."
            return
        add_log("Stack VisionCam inicializada com sucesso!")
        add_log("=== DEPLOY CONCLUÍDO ===")
        deploy_state["success"] = True
    except Exception as e:
        add_log(f"Erro ao subir stack: {e}")
        deploy_state["error"] = str(e)
    finally:
        deploy_state["is_deploying"] = False


class BootstrapHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Desabilita log de requests no console do terminal para manter limpo
        pass

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            html = self.get_html_page()
            self.wfile.write(html.encode("utf-8"))
        elif self.path == "/api/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            docker_ver = check_docker()
            compose_ver = check_docker_compose()
            internet_ok = check_internet()
            
            data = {
                "docker_installed": docker_ver is not None,
                "docker_version": docker_ver or "Não instalado",
                "compose_installed": compose_ver is not None,
                "compose_version": compose_ver or "Não instalado",
                "internet_connected": internet_ok,
                "deploying": deploy_state["is_deploying"],
                "success": deploy_state["success"]
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))
        elif self.path == "/api/logs":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            with logs_lock:
                data = {
                    "logs": deploy_state["logs"],
                    "is_deploying": deploy_state["is_deploying"],
                    "success": deploy_state["success"],
                    "error": deploy_state["error"]
                }
            self.wfile.write(json.dumps(data).encode("utf-8"))
        else:
            self.send_error(404, "File not found")

    def do_POST(self):
        if self.path == "/api/deploy":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data.decode("utf-8"))
            
            username = payload.get("username", "")
            password = payload.get("password", "")
            mgmt_mode = payload.get("mgmt_mode", "none")
            edge_key = payload.get("edge_key", "")
            edge_id = payload.get("edge_id", "")
            edge_insecure_poll = bool(payload.get("edge_insecure_poll", False))
            codigo = payload.get("codigo", "")
            cloud_url = payload.get("cloud_url", "")

            if deploy_state["is_deploying"]:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Deploy já em execução."}).encode("utf-8"))
                return

            # Inicia o deploy em outra thread
            threading.Thread(
                target=run_deployment_thread,
                args=(username, password, mgmt_mode, edge_key, edge_id,
                      edge_insecure_poll, codigo, cloud_url),
                daemon=True,
            ).start()
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "started"}).encode("utf-8"))
        else:
            self.send_error(404, "Endpoint not found")

    def get_html_page(self):
        return """<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <title>VisionCam Setup Inicial</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #020617;
            color: #f8fafc;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            width: 100%;
            max-width: 600px;
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(16px);
            border-radius: 32px;
            padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        .logo-header {
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            margin-bottom: 30px;
        }
        .icon-circle {
            background: #2563eb;
            color: #fff;
            width: 64px;
            height: 64px;
            border-radius: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 28px;
            font-weight: bold;
            box-shadow: 0 10px 20px rgba(37, 99, 235, 0.2);
            margin-bottom: 15px;
        }
        h1 { font-size: 22px; font-weight: 900; letter-spacing: -0.5px; }
        h1 span { color: #3b82f6; }
        p.subtitle { color: #64748b; font-size: 13px; margin-top: 5px; }
        
        .checks-grid {
            display: grid;
            grid-cols: 1;
            gap: 12px;
            margin-bottom: 30px;
        }
        .check-card {
            background: rgba(2, 6, 23, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.03);
            border-radius: 16px;
            padding: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .check-label { font-size: 12px; color: #94a3b8; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
        .check-status { font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 8px; }
        .badge {
            padding: 4px 10px;
            border-radius: 9999px;
            font-size: 11px;
            font-weight: 900;
            text-transform: uppercase;
        }
        .badge.ok { background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); }
        .badge.err { background: rgba(244, 63, 94, 0.1); color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.2); }

        .form-group { margin-bottom: 20px; }
        label.field-label { display: block; font-size: 10px; font-weight: 900; text-transform: uppercase; color: #64748b; letter-spacing: 1px; margin-left: 4px; margin-bottom: 8px; }
        input[type="text"], input[type="password"], select.form-select {
            width: 100%;
            background: #020617;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 14px;
            padding: 14px 16px;
            font-size: 14px;
            color: #fff;
            outline: none;
            transition: all 0.3s;
        }
        select.form-select {
            appearance: none;
            -webkit-appearance: none;
            background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2364748b' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E");
            background-position: right 12px center;
            background-repeat: no-repeat;
            background-size: 20px;
            padding-right: 40px;
            cursor: pointer;
        }
        input:focus, select:focus { border-color: #3b82f6; }
        
        button.btn-deploy {
            width: 100%;
            background: #fff;
            color: #020617;
            font-size: 12px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 2px;
            padding: 16px;
            border: none;
            border-radius: 16px;
            cursor: pointer;
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
            transition: all 0.3s;
        }
        button.btn-deploy:hover { background: #3b82f6; color: #fff; }
        button:disabled { background: rgba(255, 255, 255, 0.1) !important; color: #64748b !important; cursor: not-allowed; }

        .console-container {
            margin-top: 30px;
            background: #020617;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 20px;
            padding: 20px;
            display: none;
        }
        .console-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .console-title { font-size: 10px; font-weight: 900; text-transform: uppercase; color: #3b82f6; letter-spacing: 1px; }
        .console-terminal {
            height: 200px;
            overflow-y: auto;
            font-family: "Courier New", Courier, monospace;
            font-size: 12px;
            color: #94a3b8;
            line-height: 1.6;
            white-space: pre-wrap;
        }
        .codigo-input {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 2rem; font-weight: 800; letter-spacing: 0.25em;
            text-align: center; text-transform: uppercase;
        }
        .dica { font-size: 0.78rem; color: #94a3b8; margin-top: 8px; line-height: 1.5; }
        .avancado { margin-top: 18px; border-top: 1px solid #1e293b; padding-top: 14px; }
        .avancado summary {
            cursor: pointer; font-size: 0.8rem; color: #64748b;
            text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700;
        }
    </style>
    <script>
        let pollInterval = null;

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('dock-ver').innerHTML = data.docker_installed 
                    ? `<span class="badge ok">OK (${data.docker_version.split(',')[0]})</span>` 
                    : '<span class="badge err">Não instalado</span>';
                
                document.getElementById('comp-ver').innerHTML = data.compose_installed 
                    ? `<span class="badge ok">OK (${data.compose_version.split(' ')[2] || 'V2'})</span>` 
                    : '<span class="badge err">Não instalado</span>';

                document.getElementById('net-status').innerHTML = data.internet_connected 
                    ? '<span class="badge ok">Conectado</span>' 
                    : '<span class="badge err">Sem Conexão</span>';

                if (!data.docker_installed || !data.compose_installed || !data.internet_connected) {
                    document.getElementById('btn-start').disabled = true;
                } else if (!data.deploying) {
                    document.getElementById('btn-start').disabled = false;
                }
                
                if (data.deploying) {
                    showConsole();
                }
            } catch(e) {}
        }

        function showConsole() {
            document.getElementById('console').style.display = 'block';
            document.getElementById('btn-start').disabled = true;
            if (!pollInterval) {
                pollInterval = setInterval(fetchLogs, 1500);
            }
        }

        async function fetchLogs() {
            try {
                const res = await fetch('/api/logs');
                const data = await res.json();
                const term = document.getElementById('terminal');
                
                term.textContent = data.logs.join('\\n');
                term.scrollTop = term.scrollHeight; // Auto scroll
                
                if (data.error) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    alert("Erro no Deploy: " + data.error);
                    document.getElementById('btn-start').disabled = false;
                }
                
                if (data.success) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    term.textContent += '\\n\\n=== DEPLOY EFETUADO COM SUCESSO! ===\\nAcesse o painel local em http://localhost:3000';
                    term.scrollTop = term.scrollHeight;
                }
            } catch(e) {}
        }

        function toggleEdgeFields() {
            const mode = document.getElementById('mgmt_mode').value;
            const edgeFields = document.getElementById('edge-fields');
            if (mode === 'portainer-edge-agent') {
                edgeFields.style.display = 'block';
            } else {
                edgeFields.style.display = 'none';
            }
        }

        // Insere o hifen e forca maiusculas enquanto o tecnico digita, para que
        // o campo ja mostre o mesmo formato impresso no console.
        function formatarCodigo(campo) {
            let v = campo.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
            campo.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
        }

        async function startDeploy(e) {
            e.preventDefault();
            const user = document.getElementById('user').value;
            const pass = document.getElementById('pass').value;
            const mgmtMode = document.getElementById('mgmt_mode').value;
            const edgeKey = document.getElementById('edge_key').value;
            const edgeId = document.getElementById('edge_id').value;
            
            showConsole();
            
            try {
                const res = await fetch('/api/deploy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        username: user, 
                        password: pass,
                        mgmt_mode: mgmtMode,
                        edge_key: edgeKey,
                        edge_id: edgeId
                    })
                });
                
                if (res.status !== 200) {
                    const err = await res.json();
                    alert(err.error);
                }
            } catch(e) {
                alert("Falha na chamada ao bootstrap.");
            }
        }

        window.onload = () => {
            updateStatus();
            setInterval(updateStatus, 3000);
            toggleEdgeFields();
        };
    </script>
</head>
<body>
    <div class="container">
        <div class="logo-header">
            <div class="icon-circle">V</div>
            <h1>Setup Inicial <span>VisionCam</span></h1>
            <p class="subtitle">Instalação e deploy automatizado de imagens de borda</p>
        </div>

        <div class="checks-grid">
            <div class="check-card">
                <span class="check-label">Docker Daemon</span>
                <span id="dock-ver" class="check-status"><span class="badge err">Checando...</span></span>
            </div>
            <div class="check-card">
                <span class="check-label">Docker Compose Extension</span>
                <span id="comp-ver" class="check-status"><span class="badge err">Checando...</span></span>
            </div>
            <div class="check-card">
                <span class="check-label">Docker Hub Gateway API</span>
                <span id="net-status" class="check-status"><span class="badge err">Checando...</span></span>
            </div>
        </div>

        <form onsubmit="startDeploy(event)">
            <div class="form-group">
                <label class="field-label">Código de Provisionamento</label>
                <input type="text" id="codigo" class="codigo-input"
                       placeholder="XXXX-XXXX" maxlength="9" autocomplete="off"
                       autocapitalize="characters" spellcheck="false"
                       oninput="formatarCodigo(this)">
                <p class="dica">
                    Emitido no console de nuvem, em <strong>Deploys da Frota</strong>.
                    O código traz a loja, a versão e a gerência de containers —
                    nenhuma credencial precisa ser digitada aqui.
                </p>
            </div>

            <details class="avancado">
                <summary>Instalação sem código (avançado)</summary>
                <p class="dica">
                    Use apenas em laboratório ou se a loja não tem acesso à nuvem.
                    O appliance sobe sem vínculo com nenhuma loja e não envia telemetria.
                </p>
                <div class="form-group">
                    <label class="field-label">Docker Hub — usuário (opcional)</label>
                    <input type="text" id="user" placeholder="vazio para imagens públicas">
                </div>
                <div class="form-group">
                    <label class="field-label">Docker Hub — token (opcional)</label>
                    <input type="password" id="pass" placeholder="vazio para imagens públicas">
                </div>
                <div class="form-group">
                    <label class="field-label">Modo de gerência</label>
                    <select id="mgmt_mode" class="form-select" onchange="toggleEdgeFields()">
                        <option value="none" selected>Nenhum (standalone)</option>
                        <option value="portainer-agent">Portainer Agent (rede local)</option>
                        <option value="portainer-edge-agent">Portainer Edge Agent</option>
                    </select>
                </div>
                <div id="edge-fields" style="display: none;">
                    <div class="form-group">
                        <label class="field-label">Portainer Edge Key</label>
                        <input type="text" id="edge_key" placeholder="EDGE_KEY do Portainer central">
                    </div>
                    <div class="form-group">
                        <label class="field-label">Edge Device ID (opcional)</label>
                        <input type="text" id="edge_id" placeholder="vazio usa o hostname">
                    </div>
                </div>
            </details>
            </div>
            <button type="submit" id="btn-start" class="btn-deploy" disabled>Iniciar Deploy</button>
        </form>

        <div id="console" class="console-container">
            <div class="console-header">
                <span class="console-title">Console de Instalação</span>
                <span style="color: #64748b; font-size: 10px; font-family: monospace;">LOGS</span>
            </div>
            <div id="terminal" class="console-terminal">Iniciando console...</div>
        </div>
    </div>
</body>
</html>
"""

def main():
    Handler = BootstrapHandler
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"=== VisionCam Bootstrap Server rodando na porta {PORT} ===")
        print(f"Abra o navegador em http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nEncerrando servidor bootstrap...")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="VisionCam Edge Bootstrap Installer")
    parser.add_argument("--auto", action="store_true", help="Executa o deploy automático direto")
    parser.add_argument("--user", default="", help="Username do Docker Hub")
    parser.add_argument("--pass", dest="password", default="", help="Password/Token do Docker Hub")
    parser.add_argument("--mgmt-mode", default="none", choices=["none", "portainer-agent", "portainer-edge-agent"], help="Modo de gerenciamento de containers")
    parser.add_argument("--edge-key", default="", help="Portainer Edge Key")
    parser.add_argument("--edge-id", default="", help="Portainer Edge ID")
    parser.add_argument(
        "--edge-insecure-poll",
        action="store_true",
        help=(
            "Aceita certificado inválido do servidor Portainer. Use apenas com "
            "servidor autoassinado: o canal de gerência tem acesso ao socket "
            "Docker, e sem verificação um atacante interposto pode implantar "
            "containers arbitrários neste appliance."
        ),
    )

    parser.add_argument("--codigo", default="",
                        help="Codigo de provisionamento emitido no console de nuvem")
    parser.add_argument("--cloud-url", default="",
                        help="URL do console de nuvem (padrao: variavel CLOUD_URL)")

    args, unknown = parser.parse_known_args()

    if args.auto:
        print("=== MODO AUTOMÁTICO DETECTADO (DEPLOY DIRETO) ===")
        run_deployment_thread(args.user, args.password, args.mgmt_mode, args.edge_key,
                              args.edge_id, args.edge_insecure_poll,
                              args.codigo, args.cloud_url)
    else:
        main()
