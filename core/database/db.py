import aiosqlite
import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from core.security import hash_password

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DB_DIR, exist_ok=True)

SYSTEM_DB_PATH = os.path.join(DB_DIR, "system.db")
QUEUE_DB_PATH = os.path.join(DB_DIR, "queue.db")

async def init_db():
    # Initialize system.db
    async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL") # Enable concurrent access
        await db.execute("""
            CREATE TABLE IF NOT EXISTS zones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                points_json TEXT NOT NULL,
                is_active BOOLEAN DEFAULT 1,
                trigger_count INTEGER DEFAULT 0,
                camera_name TEXT DEFAULT 'camera_principal'
            )
        """)
        
        # Migrations
        try: await db.execute("ALTER TABLE zones ADD COLUMN is_active BOOLEAN DEFAULT 1")
        except: pass
        try: await db.execute("ALTER TABLE zones ADD COLUMN trigger_count INTEGER DEFAULT 0")
        except: pass
        try: await db.execute("ALTER TABLE zones ADD COLUMN camera_name TEXT DEFAULT 'camera_principal'")
        except: pass
        
        await db.execute("""
            CREATE TABLE IF NOT EXISTS cameras (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                rtsp_url TEXT NOT NULL,
                is_active BOOLEAN DEFAULT 1
            )
        """)
        
        await db.execute("INSERT OR IGNORE INTO cameras (name, rtsp_url, is_active) VALUES ('camera_principal', 'rtsp://127.0.0.1:8554/live', 1)")
        
        await db.execute("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        # Seed default configurations if not present
        default_configs = {
            "model_source": "hybrid",
            "enable_fallback": "false",
            "camera_name": "Câmera Principal",
            "route_left": "Esquerda",
            "route_right": "Direita",
            "brain_rules": "Analyze for shoplifting or product concealment.",
            # Senha inicial "admin", com hash gerado em tempo de execucao para
            # que nenhum digest fique fixo no fonte. O flag abaixo permite a UI
            # cobrar a troca antes de colocar o appliance em producao.
            "admin_password_hash": hash_password("admin"),
            "password_is_default": "true",
            "cloud_api_url": "https://api.visioncam.com.br/v1",
            "store_api_key": "vc_key_tok_loja_centro_001"
        }
        for key, val in default_configs.items():
            await db.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", (key, val))
        await db.commit()
        
    # Initialize queue.db
    async with aiosqlite.connect(QUEUE_DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL,
                status TEXT DEFAULT 'PENDING',
                video_path TEXT NOT NULL,
                ai_verdict BOOLEAN,
                payload_json TEXT,
                suspicion_score REAL DEFAULT 0.0
            )
        """)
        
        # Migrations
        try: await db.execute("ALTER TABLE events ADD COLUMN suspicion_score REAL DEFAULT 0.0")
        except: pass
        
        await db.execute("""
            CREATE TABLE IF NOT EXISTS telemetry (
                timestamp REAL PRIMARY KEY,
                cpu_usage REAL,
                ram_usage REAL,
                inference_ms REAL
            )
        """)
        await db.commit()

async def get_system_db():
    db = await aiosqlite.connect(SYSTEM_DB_PATH)
    await db.execute("PRAGMA journal_mode=WAL")
    db.row_factory = aiosqlite.Row
    return db

async def get_queue_db():
    db = await aiosqlite.connect(QUEUE_DB_PATH)
    await db.execute("PRAGMA journal_mode=WAL")
    db.row_factory = aiosqlite.Row
    return db
