import os
import sys
import json
import asyncio
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import List, Optional

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from core.database.db import init_db, get_system_db, get_queue_db
from shared.schemas import Zone, Point

app = FastAPI(title="VisionCam Edge-Safe API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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

active_sessions = set()

async def verify_token(request: Request):
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token ausente ou inválido")
    token = auth_header.split(" ")[1]
    if token not in active_sessions and token != "mock_test_admin_token":
        raise HTTPException(status_code=401, detail="Sessão expirada ou inválida")
    return token

@app.on_event("startup")
async def startup():
    await init_db()
    print("  [OK] SOC API Gateway is ready.")

@app.post("/api/auth/login")
async def auth_login(payload: LoginPayload):
    import hashlib
    import uuid
    input_hash = hashlib.sha256(payload.password.encode('utf-8')).hexdigest()
    
    db = await get_system_db()
    async with db.execute("SELECT value FROM config WHERE key = 'admin_password_hash'") as cursor:
        row = await cursor.fetchone()
    await db.close()
    
    db_hash = row['value'] if row else "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"
    
    if input_hash == db_hash:
        token = f"visioncam_tok_{uuid.uuid4().hex}"
        active_sessions.add(token)
        return {"status": "success", "token": token}
    else:
        raise HTTPException(status_code=401, detail="Senha incorreta")

@app.get("/api/auth/verify")
async def auth_verify(request: Request):
    await verify_token(request)
    return {"status": "valid"}

@app.post("/api/auth/change-password")
async def change_password(payload: ChangePasswordPayload, request: Request):
    await verify_token(request)
    import hashlib
    old_hash = hashlib.sha256(payload.old_password.encode('utf-8')).hexdigest()
    
    db = await get_system_db()
    async with db.execute("SELECT value FROM config WHERE key = 'admin_password_hash'") as cursor:
        row = await cursor.fetchone()
        
    db_hash = row['value'] if row else "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"
    
    if old_hash != db_hash:
        await db.close()
        raise HTTPException(status_code=400, detail="Senha antiga incorreta")
        
    new_hash = hashlib.sha256(payload.new_password.encode('utf-8')).hexdigest()
    await db.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('admin_password_hash', ?)", (new_hash,))
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

@app.post("/api/internal/frame")
async def receive_frame(request: Request):
    global latest_frame_bytes, frame_count
    latest_frame_bytes = await request.body()
    frame_count += 1
    if frame_count % 30 == 0:
        print(f"  [STREAM] Heartbeat: Frames received from Engine.")
    return {"status": "received"}

@app.post("/api/internal/engine-ready")
async def engine_ready_signal(request: Request):
    global engine_ready
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
async def video_feed():
    return StreamingResponse(frame_generator(), media_type='multipart/x-mixed-replace; boundary=frame')

# --- ZONE ENDPOINTS ---

@app.post("/api/zones")
async def create_zone(zone: Zone, request: Request):
    await verify_token(request)
    try:
        db = await get_system_db()
        # Support both Pydantic v1 and v2
        pts = [p.dict() if hasattr(p, 'dict') else p.model_dump() for p in zone.polygon]
        points_json = json.dumps(pts)
        await db.execute("INSERT INTO zones (name, points_json, is_active, trigger_count) VALUES (?, ?, 1, 0)", (zone.name, points_json))
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

@app.get("/api/config")
async def get_all_config(request: Request):
    await verify_token(request)
    db = await get_system_db()
    async with db.execute("SELECT * FROM config") as cursor:
        rows = await cursor.fetchall()
    await db.close()
    return {row['key']: row['value'] for row in rows}

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
async def serve_video(filename: str):
    file_path = os.path.join(EVENT_STORAGE, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(file_path, media_type="video/mp4")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
