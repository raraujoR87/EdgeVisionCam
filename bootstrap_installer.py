import http.server
import socketserver
import json
import subprocess
import threading
import socket
import urllib.request
import os
import time

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

def check_docker_compose():
    try:
        res = subprocess.run(["docker", "compose", "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        return res.stdout.strip() if res.returncode == 0 else None
    except Exception:
        return None

def run_deployment_thread(username, password, mgmt_mode="none", edge_key="", edge_id=""):
    global deploy_state
    deploy_state["is_deploying"] = True
    deploy_state["success"] = False
    deploy_state["error"] = None
    deploy_state["logs"] = []
    
    add_log("Iniciando processo de deploy automático no Radxa Cubie...")
    
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

    # 2. Escrever docker-compose.yml
    add_log("Gerando arquivo de configuração docker-compose.yml local...")
    
    # Determina o bloco do gerenciador (Portainer Agent ou Edge Agent ou nenhum)
    mgmt_service = ""
    if mgmt_mode == "portainer-agent":
        mgmt_service = """  portainer-agent:
    image: portainer/agent:latest
    container_name: visioncam-portainer-agent
    restart: always
    ports:
      - "9001:9001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
"""
    elif mgmt_mode == "portainer-edge-agent":
        if not edge_id:
            try:
                edge_id = f"edge-{socket.gethostname()}"
            except Exception:
                edge_id = "edge-device"
        mgmt_service = f"""  portainer-edge-agent:
    image: portainer/edge-agent:latest
    container_name: visioncam-portainer-edge-agent
    restart: always
    environment:
      - EDGE_KEY={edge_key}
      - EDGE_ID={edge_id}
      - EDGE_INSECURE_POLL=1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
"""

    compose_content = f"""version: '3.8'

services:
{mgmt_service}
  mqtt:
    image: eclipse-mosquitto:2
    container_name: visioncam-mqtt
    restart: always
    ports:
      - "1883:1883"
    volumes:
      - mqtt_data:/mosquitto/data
      - mqtt_log:/mosquitto/log

  frigate:
    image: ghcr.io/blakeblackshear/frigate:stable
    container_name: visioncam-frigate
    restart: always
    privileged: true
    shm_size: "128mb"
    devices:
      - /dev/dri:/dev/dri
      - /dev/galcore:/dev/galcore
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - ./frigate_config.yml:/config/config.yml
      - ./storage/clips:/media/frigate/clips
    ports:
      - "5000:5000"
      - "8554:8554"
    depends_on:
      - mqtt

  visioncam-core:
    image: raphael7araujo/visioncam-core:latest
    container_name: visioncam-core
    restart: always
    environment:
      - FRIGATE_URL=http://frigate:5000
      - MQTT_HOST=mqtt
      - CLOUD_API_URL=https://api.visioncam.com.br/v1
    volumes:
      - db_data:/app/core/database/data
      - ./storage/events:/app/edge/storage/events
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "8090:8090"
      - "8000:8000"
    depends_on:
      - frigate
      - mqtt

  visioncam-ui:
    image: raphael7araujo/visioncam-ui:latest
    container_name: visioncam-ui-local
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - db_data:/app/core/database/data
    environment:
      - NEXT_PUBLIC_API_URL=http://visioncam-core:8000
      - NEXT_PUBLIC_LOCAL_ONLY=true
    depends_on:
      - visioncam-core

volumes:
  db_data:
  mqtt_data:
  mqtt_log:
"""
    try:
        with open("docker-compose.yml", "w", encoding="utf-8") as f:
            f.write(compose_content)
        add_log("Arquivo docker-compose.yml gerado.")
    except Exception as e:
        add_log(f"Falha ao escrever docker-compose.yml: {e}")
        deploy_state["is_deploying"] = False
        deploy_state["error"] = f"Erro ao criar compose: {e}"
        return

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
            ["docker", "compose", "pull"],
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
            ["docker", "compose", "up", "-d"],
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
            
            if deploy_state["is_deploying"]:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Deploy já em execução."}).encode("utf-8"))
                return

            # Inicia o deploy em outra thread
            threading.Thread(target=run_deployment_thread, args=(username, password, mgmt_mode, edge_key, edge_id), daemon=True).start()
            
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
                <label class="field-label">Docker Hub Username (Opcional)</label>
                <input type="text" id="user" placeholder="ex: visioncam_admin (vazio para imagens públicas)">
            </div>
            <div class="form-group">
                <label class="field-label">Docker Hub Access Token / Password (Opcional)</label>
                <input type="password" id="pass" placeholder="dckr_pat_... (vazio para imagens públicas)">
            </div>
            <div class="form-group">
                <label class="field-label">Modo de Gerenciamento de Contêineres</label>
                <select id="mgmt_mode" class="form-select" onchange="toggleEdgeFields()">
                    <option value="none">Nenhum (Standalone)</option>
                    <option value="portainer-agent" selected>Portainer Agent (Local/VPN na porta 9001)</option>
                    <option value="portainer-edge-agent">Portainer Edge Agent (Multi-Cliente Nuvem)</option>
                </select>
            </div>
            <div id="edge-fields" style="display: none;">
                <div class="form-group">
                    <label class="field-label">Portainer Edge Key</label>
                    <input type="text" id="edge_key" placeholder="EDGE_KEY gerada pelo Portainer Central">
                </div>
                <div class="form-group">
                    <label class="field-label">Edge Device ID (Opcional)</label>
                    <input type="text" id="edge_id" placeholder="ex: clienteA-loja01 (vazio para usar hostname)">
                </div>
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
    
    args, unknown = parser.parse_known_args()
    
    if args.auto:
        print("=== MODO AUTOMÁTICO DETECTADO (DEPLOY DIRETO) ===")
        run_deployment_thread(args.user, args.password, args.mgmt_mode, args.edge_key, args.edge_id)
    else:
        main()
