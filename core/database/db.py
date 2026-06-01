import aiosqlite
import os

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
                trigger_count INTEGER DEFAULT 0
            )
        """)
        
        # Migrations
        try: await db.execute("ALTER TABLE zones ADD COLUMN is_active BOOLEAN DEFAULT 1")
        except: pass
        try: await db.execute("ALTER TABLE zones ADD COLUMN trigger_count INTEGER DEFAULT 0")
        except: pass
        
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
            "admin_password_hash": "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918" # sha256("admin")
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
