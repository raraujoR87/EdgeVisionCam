import os
import sys
import json
import asyncio
import hmac
from contextlib import asynccontextmanager
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from core.database.db import init_db, get_system_db, get_queue_db
from core.security import (
    INTERNAL_SECRET_KEY,
    SESSION_SECRET_KEY,
    get_or_create_secret,
    hash_password,
    is_legacy_hash,
    issue_token,
    validate_token,
    verify_password,
)
from shared.schemas import Zone, Point
import re

class CameraPayload(BaseModel):
    id: Optional[int] = None
    name: str
    rtsp_url: str
    is_active: bool = True

def sanitize_camera_name(name: str) -> str:
    cleaned = name.lower().strip()
    cleaned = re.sub(r'[^a-z0-9_]', '_', cleaned)
    cleaned = re.sub(r'_+', '_', cleaned)
    return cleaned.strip('_')

def generate_frigate_config():
    import sqlite3
    try:
        db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'database', 'data', 'system.db'))
        if not os.path.exists(db_path):
            print(f"  [FRIGATE CONFIG] DB not found at {db_path}, skipping config generation.")
            return False
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT name, rtsp_url FROM cameras WHERE is_active = 1")
        rows = cur.fetchall()
        conn.close()
        
        yaml_lines = [
            "mqtt:",
            "  host: mqtt",
            "",
            "cameras:"
        ]
        
        if not rows:
            yaml_lines.extend([
                "  camera_principal:",
                "    enabled: true",
                "    ffmpeg:",
                "      inputs:",
                "        - path: rtsp://127.0.0.1:8554/live",
                "          roles:",
                "            - detect",
                "            - record",
                "    detect:",
                "      enabled: true",
                "      width: 640",
                "      height: 480",
                "      fps: 5",
                "    record:",
                "      enabled: true",
                "      retain:",
                "        days: 3",
                "        mode: all"
            ])
        else:
            for row in rows:
                cam_name = sanitize_camera_name(row['name'])
                rtsp_url = row['rtsp_url']
                yaml_lines.extend([
                    f"  {cam_name}:",
                    "    enabled: true",
                    "    ffmpeg:",
                    "      inputs:",
                    f"        - path: {rtsp_url}",
                    "          roles:",
                    "            - detect",
                    "            - record",
                    "    detect:",
                    "      enabled: true",
                    "      width: 640",
                    "      height: 480",
                    "      fps: 5",
                    "    record:",
                    "      enabled: true",
                    "      retain:",
                    "        days: 3",
                    "        mode: all"
                ])
                
        config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'frigate_config.yml'))
        with open(config_path, 'w', encoding='utf-8') as f:
            f.write("\n".join(yaml_lines) + "\n")
        print(f"  [FRIGATE CONFIG] Generated config file at {config_path}")
        return True
    except Exception as e:
        print(f"  [FRIGATE CONFIG ERROR] Failed to generate: {e}")
        import traceback; traceback.print_exc()
        return False

def restart_frigate_container():
    import socket
    socket_path = "/var/run/docker.sock"
    if not os.path.exists(socket_path):
        print("  [DOCKER] Socket not found at /var/run/docker.sock, skipping container restart.")
        return False
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(socket_path)
        request = (
            "POST /v1.41/containers/visioncam-frigate/restart HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Connection: close\r\n\r\n"
        )
        client.sendall(request.encode('utf-8'))
        response = client.recv(4096).decode('utf-8', errors='ignore')
        client.close()
        print(f"  [DOCKER] Frigate container restart command sent: {response.splitlines()[0]}")
        return True
    except Exception as e:
        print(f"  [DOCKER ERROR] Failed to restart visioncam-frigate container: {e}")
        return False

@asynccontextmanager
async def lifespan(app: FastAPI):
    # `on_event` esta depreciado no FastAPI e emitia aviso a cada boot.
    await startup()
    yield


app = FastAPI(title="VisionCam Edge-Safe API", lifespan=lifespan)

# O appliance e acessado pelo IP da LAN, que varia por instalacao, entao a
# origem permissiva continua sendo o padrao. Os tokens viajam no header
# Authorization (nunca em cookie), logo o navegador nao os anexa sozinho e
# nao ha vetor de CSRF aqui. Instalacoes com origem fixa devem restringir
# via ALLOWED_ORIGINS.
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

EVENT_STORAGE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'edge', 'storage', 'events'))
os.makedirs(EVENT_STORAGE, exist_ok=True)

# Shared memory/queue for live stream
latest_frame_bytes = None
frame_count = 0
engine_ready = False  # Set to True when engine signals ready

class ConfigPayload(BaseModel):
    key: str
    value: str

class WebhookPayload(BaseModel):
    event_id: int
    action: str  # "CONFIRM" or "IGNORE"
    feedback_text: Optional[str] = None

class LoginPayload(BaseModel):
    password: str

class ChangePasswordPayload(BaseModel):
    old_password: str
    new_password: str

# Segredos carregados uma vez no startup e reutilizados a cada request, para
# nao pagar um round-trip ao SQLite em toda chamada autenticada.
SESSION_SECRET = ""
INTERNAL_SECRET = ""


def extract_token(request: Request) -> str:
    """
    Recupera o token do header Authorization ou, em ultimo caso, da query
    string. A query string existe porque o <img> que consome o MJPEG nao
    consegue enviar headers — nenhum outro endpoint deve depender dela.
    """
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    return request.query_params.get("token", "")


async def verify_token(request: Request):
    token = extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Token ausente ou inválido")
    if not validate_token(SESSION_SECRET, token):
        raise HTTPException(status_code=401, detail="Sessão expirada ou inválida")
    return token


async def verify_internal(request: Request):
    """
    Protege os endpoints que so a engine local deve chamar. Sem isso, qualquer
    um na rede consegue injetar frames arbitrarios no monitor do SOC.
    """
    provided = request.headers.get("X-Internal-Token", "")
    if not provided or not hmac.compare_digest(provided, INTERNAL_SECRET):
        raise HTTPException(status_code=401, detail="Chamada interna não autorizada")


async def startup():
    """Cria o schema e carrega os segredos. Chamada pelo lifespan da app."""
    global SESSION_SECRET, INTERNAL_SECRET
    await init_db()

    db = await get_system_db()
    SESSION_SECRET = await get_or_create_secret(db, SESSION_SECRET_KEY)
    INTERNAL_SECRET = await get_or_create_secret(db, INTERNAL_SECRET_KEY)

    async with db.execute(
        "SELECT value FROM config WHERE key = 'password_is_default'"
    ) as cursor:
        row = await cursor.fetchone()
    await db.close()

    if row and row['value'] == 'true':
        print("  [AVISO] O appliance ainda usa a senha padrão. Troque-a em Settings.")

    print("  [OK] SOC API Gateway is ready.")

@app.post("/api/auth/login")
async def auth_login(payload: LoginPayload):
    db = await get_system_db()
    async with db.execute("SELECT value FROM config WHERE key = 'admin_password_hash'") as cursor:
        row = await cursor.fetchone()

    stored = row['value'] if row else ""
    if not stored or not verify_password(payload.password, stored):
        await db.close()
        raise HTTPException(status_code=401, detail="Senha incorreta")

    # Login valido com hash antigo: reescreve em PBKDF2 sem incomodar o usuario.
    if is_legacy_hash(stored):
        await db.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('admin_password_hash', ?)",
            (hash_password(payload.password),),
        )
        await db.commit()
        print("  [AUTH] Hash de senha migrado de SHA-256 para PBKDF2.")

    await db.close()
    return {"status": "success", "token": issue_token(SESSION_SECRET)}

@app.get("/api/auth/verify")
async def auth_verify(request: Request):
    await verify_token(request)
    return {"status": "valid"}

@app.post("/api/auth/change-password")
async def change_password(payload: ChangePasswordPayload, request: Request):
    await verify_token(request)

    if len(payload.new_password) < 8:
        raise HTTPException(
            status_code=400, detail="A nova senha deve ter ao menos 8 caracteres"
        )

    db = await get_system_db()
    async with db.execute("SELECT value FROM config WHERE key = 'admin_password_hash'") as cursor:
        row = await cursor.fetchone()

    stored = row['value'] if row else ""
    if not stored or not verify_password(payload.old_password, stored):
        await db.close()
        raise HTTPException(status_code=400, detail="Senha antiga incorreta")

    await db.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('admin_password_hash', ?)",
        (hash_password(payload.new_password),),
    )
    await db.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('password_is_default', 'false')"
    )
    await db.commit()
    await db.close()
    return {"status": "success"}

@app.post("/api/config")
async def save_config(payload: ConfigPayload, request: Request):
    await verify_token(request)
    db = await get_system_db()
    await db.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (payload.key, payload.value))
    await db.commit()
    await db.close()
    return {"status": "success"}

@app.get("/api/engine/status")
async def get_engine_status():
    global latest_frame_bytes, engine_ready
    return {"online": latest_frame_bytes is not None, "ready": engine_ready}

@app.get("/api/logs/{container_name}")
async def get_container_logs(container_name: str, request: Request):
    await verify_token(request)
    import socket
    socket_path = "/var/run/docker.sock"
    if not os.path.exists(socket_path):
        return {"logs": "Docker socket not available on this host. Cannot read container logs."}
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(socket_path)
        request_uri = f"/v1.41/containers/{container_name}/logs?stdout=true&stderr=true&tail=150"
        req = (
            f"GET {request_uri} HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Connection: close\r\n\r\n"
        )
        client.sendall(req.encode('utf-8'))
        response_bytes = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response_bytes += chunk
        client.close()
        
        parts = response_bytes.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return {"logs": "Invalid response from Docker daemon."}
        
        body = parts[1]
        cleaned_logs = []
        i = 0
        while i < len(body):
            if i + 8 <= len(body) and body[i] in (0, 1, 2) and body[i+1] == 0 and body[i+2] == 0 and body[i+3] == 0:
                size = int.from_bytes(body[i+4:i+8], byteorder='big')
                frame = body[i+8:i+8+size]
                cleaned_logs.append(frame.decode('utf-8', errors='ignore'))
                i += 8 + size
            else:
                remaining = body[i:]
                cleaned_logs.append(remaining.decode('utf-8', errors='ignore'))
                break
                
        return {"logs": "".join(cleaned_logs)}
    except Exception as e:
        print(f"  [DOCKER ERROR] Failed to fetch logs for {container_name}: {e}")
        return {"logs": f"Error fetching logs: {str(e)}"}

@app.post("/api/internal/frame")
async def receive_frame(request: Request):
    global latest_frame_bytes, frame_count
    await verify_internal(request)
    latest_frame_bytes = await request.body()
    frame_count += 1
    if frame_count % 30 == 0:
        print(f"  [STREAM] Heartbeat: Frames received from Engine.")
    return {"status": "received"}

@app.post("/api/internal/engine-ready")
async def engine_ready_signal(request: Request):
    global engine_ready
    await verify_internal(request)
    engine_ready = True
    print("  [ENGINE] ✓ Engine pronta para detecção!")
    return {"status": "ready"}

async def frame_generator():
    global latest_frame_bytes
    placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
    placeholder[:] = (255, 0, 0)
    cv2.putText(placeholder, "WAITING FOR ENGINE...", (100, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    _, placeholder_bytes = cv2.imencode('.jpg', placeholder)
    placeholder_bytes = placeholder_bytes.tobytes()

    while True:
        frame = latest_frame_bytes if latest_frame_bytes else placeholder_bytes
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + 
               frame + b'\r\n')
        await asyncio.sleep(0.05)

@app.get("/video_feed")
async def video_feed(request: Request):
    # Autenticado via ?token= porque a tag <img> do dashboard nao envia headers.
    await verify_token(request)
    return StreamingResponse(frame_generator(), media_type='multipart/x-mixed-replace; boundary=frame')

# --- CAMERA CONFIG ENDPOINTS ---

@app.get("/api/cameras")
async def get_cameras(request: Request):
    await verify_token(request)
    db = await get_system_db()
    async with db.execute("SELECT * FROM cameras") as cursor:
        rows = await cursor.fetchall()
    await db.close()
    return [dict(row) for row in rows]

@app.post("/api/cameras")
async def save_camera(camera: CameraPayload, request: Request):
    await verify_token(request)
    db = await get_system_db()
    sanitized_name = sanitize_camera_name(camera.name)
    if not sanitized_name:
        raise HTTPException(status_code=400, detail="Nome de câmera inválido. Use apenas letras e números.")
    
    if camera.id:
        await db.execute(
            "UPDATE cameras SET name = ?, rtsp_url = ?, is_active = ? WHERE id = ?",
            (sanitized_name, camera.rtsp_url, 1 if camera.is_active else 0, camera.id)
        )
    else:
        # Check limit of 4 cameras
        async with db.execute("SELECT COUNT(*) as count FROM cameras") as cursor:
            row = await cursor.fetchone()
            if row and row['count'] >= 4:
                await db.close()
                raise HTTPException(status_code=400, detail="Limite máximo de 4 câmeras atingido.")
        await db.execute(
            "INSERT OR REPLACE INTO cameras (name, rtsp_url, is_active) VALUES (?, ?, ?)",
            (sanitized_name, camera.rtsp_url, 1 if camera.is_active else 0)
        )
    await db.commit()
    await db.close()
    
    # Regenerate config and restart Frigate
    generate_frigate_config()
    restart_frigate_container()
    
    return {"status": "success"}

@app.delete("/api/cameras/{camera_id}")
async def delete_camera(camera_id: int, request: Request):
    await verify_token(request)
    db = await get_system_db()
    await db.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
    await db.commit()
    await db.close()
    
    # Regenerate config and restart Frigate
    generate_frigate_config()
    restart_frigate_container()
    
    return {"status": "success"}

# --- ZONE ENDPOINTS ---

@app.post("/api/zones")
async def create_zone(zone: Zone, request: Request):
    await verify_token(request)
    try:
        db = await get_system_db()
        # Support both Pydantic v1 and v2
        pts = [p.dict() if hasattr(p, 'dict') else p.model_dump() for p in zone.polygon]
        points_json = json.dumps(pts)
        await db.execute("INSERT INTO zones (name, points_json, is_active, trigger_count, camera_name) VALUES (?, ?, 1, 0, ?)", (zone.name, points_json, zone.camera_name))
        await db.commit()
        await db.close()
        return {"status": "success"}
    except Exception as e:
        import traceback
        print(f"  [API ERROR] Failed to create zone: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/zones")
async def list_zones(request: Request):
    await verify_token(request)
    db = await get_system_db()
    async with db.execute("SELECT * FROM zones") as cursor:
        rows = await cursor.fetchall()
    await db.close()
    return [dict(row) for row in rows]

@app.patch("/api/zones/{zone_id}/toggle")
async def toggle_zone(zone_id: int, request: Request):
    await verify_token(request)
    db = await get_system_db()
    await db.execute("UPDATE zones SET is_active = NOT is_active WHERE id = ?", (zone_id,))
    await db.commit()
    await db.close()
    return {"status": "success"}

@app.patch("/api/zones/{zone_id}/rename")
async def rename_zone(zone_id: int, payload: ConfigPayload, request: Request):
    await verify_token(request)
    db = await get_system_db()
    await db.execute("UPDATE zones SET name = ? WHERE id = ?", (payload.value, zone_id))
    await db.commit()
    await db.close()
    return {"status": "success"}

@app.delete("/api/zones/{zone_id}")
async def delete_zone(zone_id: int, request: Request):
    await verify_token(request)
    db = await get_system_db()
    await db.execute("DELETE FROM zones WHERE id = ?", (zone_id,))
    await db.commit()
    await db.close()
    return {"status": "success"}

# A tabela `config` guarda material sensivel junto das preferencias. Estas
# chaves nunca podem sair pela API: os segredos derrubariam a autenticacao
# inteira se vazassem, e os tokens de terceiros dao acesso a servicos externos.
CONFIG_SECRET_KEYS = {
    SESSION_SECRET_KEY,
    INTERNAL_SECRET_KEY,
    "admin_password_hash",
    "gemini_api_key",
    "telegram_bot_token",
    "store_api_key",
}


@app.get("/api/config")
async def get_all_config(request: Request):
    await verify_token(request)
    db = await get_system_db()
    async with db.execute("SELECT * FROM config") as cursor:
        rows = await cursor.fetchall()
    await db.close()

    # Segredos viram um booleano "esta configurado?", que e tudo que a UI
    # precisa para renderizar o estado dos campos sem expor o valor.
    result = {}
    for row in rows:
        key, value = row['key'], row['value']
        if key in CONFIG_SECRET_KEYS:
            result[f"{key}_is_set"] = bool(value)
        else:
            result[key] = value
    return result

@app.get("/api/events")
async def list_events(request: Request, limit: int = 50):
    await verify_token(request)
    db = await get_queue_db()
    async with db.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)) as cursor:
        rows = await cursor.fetchall()
    await db.close()
    return [dict(row) for row in rows]

@app.get("/api/telemetry")
async def get_telemetry(request: Request, limit: int = 20):
    await verify_token(request)
    db = await get_queue_db()
    async with db.execute("SELECT * FROM telemetry ORDER BY timestamp DESC LIMIT ?", (limit,)) as cursor:
        rows = await cursor.fetchall()
    await db.close()
    return [dict(row) for row in rows]

@app.post("/api/webhook/telegram")
async def telegram_webhook(payload: WebhookPayload):
    status = "THEFT_CONFIRMED" if payload.action == "CONFIRM" else "CLEARED"
    q_db = await get_queue_db()
    await q_db.execute("UPDATE events SET status = ? WHERE id = ?", (status, payload.event_id))
    await q_db.commit()
    await q_db.close()
    
    s_db = await get_system_db()
    new_rule = f"\n[Few-Shot] Event ID {payload.event_id} was {status}. Context: {payload.feedback_text}"
    async with s_db.execute("SELECT value FROM config WHERE key = 'brain_rules'") as cursor:
        row = await cursor.fetchone()
    current_rules = row['value'] if row else ""
    await s_db.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('brain_rules', ?)", (current_rules + new_rule,))
    await s_db.commit()
    await s_db.close()
    return {"status": "success"}

@app.get("/media/{filename}")
async def serve_video(filename: str, request: Request):
    # Clipes de evento sao material de investigacao: exigem sessao valida.
    await verify_token(request)

    # basename descarta qualquer tentativa de travessia de diretorio antes de
    # tocarmos o disco; a checagem de prefixo cobre o resto.
    safe_name = os.path.basename(filename)
    file_path = os.path.abspath(os.path.join(EVENT_STORAGE, safe_name))
    if not file_path.startswith(EVENT_STORAGE + os.sep):
        raise HTTPException(status_code=400, detail="Caminho inválido")
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(file_path, media_type="video/mp4")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
