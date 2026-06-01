import os
import sys
import time
import sqlite3
import subprocess
import requests
import threading
from google import genai
from google.genai import types

sys.path.insert(0, '.')
from core.database.db import SYSTEM_DB_PATH

def get_config():
    try:
        conn = sqlite3.connect(SYSTEM_DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM config WHERE key IN ('telegram_bot_token', 'telegram_chat_id')")
        config = dict(cursor.fetchall())
        conn.close()
        return config.get('telegram_bot_token'), config.get('telegram_chat_id')
    except Exception as e:
        print(f"Erro ao ler banco de dados: {e}")
        return None, None

def send_msg(url, chat_id, text):
    try:
        requests.post(f"{url}/sendMessage", json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML"
        }, timeout=15)
    except Exception as e:
        print(f"Erro ao enviar mensagem: {e}")

def run_deploy(url, chat_id):
    try:
        send_msg(url, chat_id, "🔄 <b>[DEPLOY]</b> Executando <code>docker compose pull</code> nas imagens de produção...")
        proc_pull = subprocess.run(["docker", "compose", "pull"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
        
        send_msg(url, chat_id, "🔄 <b>[DEPLOY]</b> Executando <code>docker compose up -d</code> para reiniciar a stack...")
        proc_up = subprocess.run(["docker", "compose", "up", "-d"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        
        if proc_up.returncode == 0:
            send_msg(url, chat_id, "✅ <b>[DEPLOY]</b> Stack atualizada e reiniciada com sucesso via comando remoto!")
        else:
            err = proc_up.stderr.strip() or proc_up.stdout.strip()
            send_msg(url, chat_id, f"❌ <b>[DEPLOY]</b> Falha ao subir contêineres:\n<pre>{err[:3500]}</pre>")
    except Exception as e:
        send_msg(url, chat_id, f"❌ <b>[DEPLOY]</b> Erro de exceção: {e}")

def call_gemini_agent(prompt, history=[]):
    api_key = None
    try:
        conn = sqlite3.connect(SYSTEM_DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM config WHERE key = 'gemini_api_key'")
        row = cursor.fetchone()
        conn.close()
        api_key = row[0] if row else None
    except Exception as e:
        print(f"Erro ao ler chave do Gemini: {e}")
        return f"Erro ao ler chave do Gemini: {e}"
        
    if not api_key:
        return "Erro: gemini_api_key não configurada no banco de dados SQLite."
        
    try:
        client = genai.Client(api_key=api_key)
        model = "gemini-2.5-flash"
        
        contents = []
        for msg in history:
            contents.append(types.Content(
                role=msg["role"],
                parts=[types.Part.from_text(text=msg["text"])]
            ))
        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(text=prompt)]
        ))
        
        config = types.GenerateContentConfig(
            system_instruction=(
                "Você é o VisionCam Local Developer Agent. Você tem acesso de leitura/escrita no projeto local "
                "e pode executar comandos de terminal no host (Windows PowerShell).\n"
                "Para rodar um comando no terminal, escreva exatamente o bloco:\n"
                "[RUN_CMD]\n"
                "<comando aqui>\n"
                "[END_CMD]\n"
                "Ao receber a saída do terminal, você pode planejar os próximos passos e enviar outro comando, "
                "ou concluir respondendo ao usuário em português explicativo.\n\n"
                "Para criar ou atualizar um arquivo, escreva exatamente:\n"
                "[WRITE_FILE] <caminho do arquivo>\n"
                "<conteúdo completo do arquivo>\n"
                "[END_WRITE]\n\n"
                "Exemplo: se o usuário pedir para instalar o git via winget, gere o comando winget install git. "
                "Foque em resolver o problema do usuário com ações diretas de shell no Windows."
            ),
            temperature=0.2
        )
        
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=config
        )
        return resp.text
    except Exception as e:
        return f"Erro ao chamar a API do Gemini: {e}"

def run_agent_loop(url, chat_id, instruction):
    send_msg(url, chat_id, f"🤖 <b>[AI Agent]</b> Iniciando execução da instrução:\n<i>\"{instruction}\"</i>")
    
    history = []
    current_prompt = instruction
    
    for iteration in range(10):
        print(f"[BOT-AGENT] Iteração {iteration+1}...")
        response = call_gemini_agent(current_prompt, history)
        print(f"[BOT-AGENT] Resposta do modelo:\n{response}")
        
        history.append({"role": "user", "text": current_prompt})
        history.append({"role": "model", "text": response})
        
        if "[RUN_CMD]" in response and "[END_CMD]" in response:
            try:
                start = response.find("[RUN_CMD]") + len("[RUN_CMD]")
                end = response.find("[END_CMD]")
                cmd_str = response[start:end].strip()
                
                send_msg(url, chat_id, f"💻 <b>[AI Agent - Executando]:</b>\n<code>{cmd_str}</code>")
                
                res = subprocess.run(cmd_str, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90)
                output = f"STDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}\nEXIT CODE: {res.returncode}"
                
                if len(output) > 5000:
                    output = output[:2500] + "\n... [TRUNCATED] ...\n" + output[-2500:]
                    
                current_prompt = f"Saída da execução do comando:\n{output}"
                continue
            except Exception as e:
                current_prompt = f"Exceção ao executar comando no host: {e}"
                continue
                
        elif "[WRITE_FILE]" in response and "[END_WRITE]" in response:
            try:
                start = response.find("[WRITE_FILE]") + len("[WRITE_FILE]")
                end = response.find("[END_WRITE]")
                block = response[start:end].strip()
                
                lines = block.split("\n", 1)
                filepath = lines[0].strip()
                content = lines[1] if len(lines) > 1 else ""
                
                send_msg(url, chat_id, f"📝 <b>[AI Agent - Gravando arquivo]:</b> <code>{filepath}</code>")
                
                os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(content)
                    
                current_prompt = f"Arquivo '{filepath}' gravado com sucesso no host."
                continue
            except Exception as e:
                current_prompt = f"Falha ao gravar arquivo '{filepath}': {e}"
                continue
        else:
            send_msg(url, chat_id, f"🤖 <b>[AI Agent - Concluído]:</b>\n{response}")
            break

def handle_command(url, chat_id, text):
    parts = text.split(maxsplit=1)
    cmd = parts[0].lower()
    
    # Support directing commands to specific bot username
    if "@" in cmd:
        cmd = cmd.split("@")[0]
        
    if cmd == "/help":
        msg = (
            "🤖 <b>VisionCam Admin Bot - Comandos:</b>\n\n"
            "• `/status` : Telemetria de hardware e contêineres Docker\n"
            "• `/deploy` : Executa Docker Pull e atualiza serviços Compose\n"
            "• `/logs <servico>` : Visualiza os últimos 25 logs do contêiner\n"
            "• `/config` : Lista todas as configurações SQLite do sistema\n"
            "• `/config <chave> <valor>` : Modifica uma configuração no SQLite\n"
            "• `/zones` : Lista as Zonas de Guarda calibradas\n"
            "• `/exec <instrução>` : Envia uma instrução em linguagem natural para o **Agente de IA do Gemini** agir localmente\n"
            "• `/cmd <comando>` : Executa comando terminal puro no host Windows/Linux"
        )
        send_msg(url, chat_id, msg)
        
    elif cmd == "/status":
        try:
            import psutil
            cpu = psutil.cpu_percent()
            ram = psutil.virtual_memory().percent
            sys_info = f"💻 <b>Hardware:</b>\n- CPU: {cpu}%\n- RAM: {ram}%\n"
        except Exception:
            sys_info = "💻 <b>Hardware:</b> (psutil não instalado)\n"
            
        try:
            res = subprocess.run(["docker", "ps", "--format", "table {{.Names}}\t{{.Status}}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=8)
            if res.returncode == 0:
                docker_info = f"\n🐳 <b>Contêineres:</b>\n<pre>{res.stdout.strip()}</pre>"
            else:
                docker_info = "\n🐳 <b>Docker:</b> Daemon offline ou inalcançável"
        except Exception:
            docker_info = "\n🐳 <b>Docker:</b> Não instalado ou indisponível no host"
            
        send_msg(url, chat_id, sys_info + docker_info)
        
    elif cmd == "/deploy":
        send_msg(url, chat_id, "⚙️ Iniciando processo de deploy remoto em background...")
        threading.Thread(target=run_deploy, args=(url, chat_id), daemon=True).start()
        
    elif cmd == "/logs":
        if len(parts) < 2:
            send_msg(url, chat_id, "⚠️ Uso: `/logs <nome-do-servico>`\nEx: `/logs visioncam-core`")
            return
        service = parts[1].strip()
        try:
            res = subprocess.run(["docker", "compose", "logs", "--tail=25", service], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=12)
            logs = res.stdout.strip() or res.stderr.strip() or "Nenhum log retornado."
            send_msg(url, chat_id, f"📝 <b>Logs de {service}:</b>\n<pre>{logs[-3500:]}</pre>")
        except Exception as e:
            send_msg(url, chat_id, f"❌ Erro ao buscar logs: {e}")
            
    elif cmd == "/config":
        if len(parts) == 1:
            try:
                conn = sqlite3.connect(SYSTEM_DB_PATH)
                cursor = conn.cursor()
                cursor.execute("SELECT key, value FROM config")
                rows = cursor.fetchall()
                conn.close()
                msg = "⚙️ <b>Configurações SQLite Atuais:</b>\n" + "\n".join([f"- <code>{k}</code>: {v}" for k, v in rows])
                send_msg(url, chat_id, msg)
            except Exception as e:
                send_msg(url, chat_id, f"❌ Erro ao listar: {e}")
        else:
            subparts = parts[1].split(maxsplit=1)
            if len(subparts) < 2:
                send_msg(url, chat_id, "⚠️ Uso: `/config <chave> <valor>`")
                return
            key, val = subparts
            try:
                conn = sqlite3.connect(SYSTEM_DB_PATH)
                cursor = conn.cursor()
                cursor.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, val))
                conn.commit()
                conn.close()
                send_msg(url, chat_id, f"✅ Configuração <code>{key}</code> atualizada no banco com sucesso!")
            except Exception as e:
                send_msg(url, chat_id, f"❌ Erro ao salvar: {e}")
                
    elif cmd == "/zones":
        try:
            conn = sqlite3.connect(SYSTEM_DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, is_active FROM zones")
            rows = cursor.fetchall()
            conn.close()
            if not rows:
                send_msg(url, chat_id, "ℹ️ Nenhuma zona de guarda configurada.")
            else:
                msg = "🗺️ <b>Zonas de Guarda:</b>\n" + "\n".join([f"- [{r[0]}] <b>{r[1]}</b> ({'Ativa' if r[2] else 'Inativa'})" for r in rows])
                send_msg(url, chat_id, msg)
        except Exception as e:
            send_msg(url, chat_id, f"❌ Erro ao listar zonas: {e}")
            
    elif cmd == "/exec":
        if len(parts) < 2:
            send_msg(url, chat_id, "⚠️ Uso: `/exec <instrução em linguagem natural>`\nEx: `/exec instale o git` ou `/exec crie um arquivo teste.txt`")
            return
        instruction = parts[1].strip()
        threading.Thread(target=run_agent_loop, args=(url, chat_id, instruction), daemon=True).start()
        
    elif cmd == "/cmd":
        if len(parts) < 2:
            send_msg(url, chat_id, "⚠️ Uso: `/cmd <comando do shell>`\nEx: `/cmd dir` ou `/cmd docker ps`")
            return
        shell_cmd = parts[1].strip()
        try:
            res = subprocess.run(shell_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
            out = res.stdout.strip() or res.stderr.strip() or "Comando executado sem retorno."
            send_msg(url, chat_id, f"💻 <b>Resultado do Shell:</b>\n<pre>{out[-3800:]}</pre>")
        except Exception as e:
            send_msg(url, chat_id, f"❌ Erro ao executar: {e}")
            
    else:
        send_msg(url, chat_id, "⚠️ Comando desconhecido. Envie /help para ajuda.")

def main():
    print("Iniciando carregamento do bot administrativo...")
    offset = 0
    
    # Give database a second to initialize if starting concurrently
    time.sleep(2)
    
    token, authorized_chat_id = get_config()
    if not token or not authorized_chat_id:
        print("Erro: Credenciais do Telegram ausentes no SQLite. Impossível iniciar loop do bot.")
        return
        
    url = f"https://api.telegram.org/bot{token}"
    print(f"=== VisionCam Telegram Bridge Bot Inicializado ===")
    print(f"Chat ID Autorizado: {authorized_chat_id}")
    
    send_msg(url, authorized_chat_id, "🤖 <b>VisionCam Admin Bot está ONLINE!</b>\nEnvie /help para ajuda remota.")
    
    while True:
        try:
            # Dynamic config reload so changes to credentials take effect without restarting script
            token, authorized_chat_id = get_config()
            if not token or not authorized_chat_id:
                time.sleep(10)
                continue
            url = f"https://api.telegram.org/bot{token}"
            
            resp = requests.get(f"{url}/getUpdates", params={"offset": offset, "timeout": 20}, timeout=25)
            if resp.status_code != 200:
                print(f"[BOT] Falha no getUpdates (Status {resp.status_code}): {resp.text}")
                time.sleep(5)
                continue
                
            updates = resp.json().get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                print(f"[BOT] Update recebido ID {update['update_id']}")
                message = update.get("message") or update.get("channel_post")
                if not message:
                    print("[BOT] Update sem mensagem ou post de canal.")
                    continue
                    
                chat = message.get("chat", {})
                chat_id = str(chat.get("id"))
                
                # Dynamic validation matching authorized chat ID
                if chat_id != str(authorized_chat_id):
                    print(f"[BOT] Ignorando update do chat_id {chat_id} (Autorizado: {authorized_chat_id})")
                    continue
                    
                text = message.get("text", "").strip()
                print(f"[BOT] Mensagem recebida no chat autorizado: '{text}'")
                if not text.startswith("/"):
                    continue
                    
                print(f"[BOT] Executando comando: '{text}'")
                handle_command(url, chat_id, text)
                
        except Exception as e:
            print(f"Erro no loop do bot: {e}")
            time.sleep(5)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nEncerrando bot...")
