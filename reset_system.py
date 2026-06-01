import os
import shutil

# Paths to databases
DB_DIR = os.path.join(os.path.dirname(__file__), "core", "database", "data")

def reset():
    print("--- SYSTEM RESET: CLEARING ALL DATA ---")
    if os.path.exists(DB_DIR):
        print(f"Removing old databases from {DB_DIR}...")
        for f in os.listdir(DB_DIR):
            if f.endswith(".db") or f.endswith(".db-wal") or f.endswith(".db-shm"):
                try:
                    os.remove(os.path.join(DB_DIR, f))
                    print(f"  [OK] Deleted: {f}")
                except Exception as e:
                    print(f"  [ERR] Could not delete {f}: {e}")
    
    # Also clear events
    EVENT_DIR = os.path.join(os.path.dirname(__file__), "edge", "storage", "events")
    if os.path.exists(EVENT_DIR):
        print(f"Clearing event clips from {EVENT_DIR}...")
        for f in os.listdir(EVENT_DIR):
            try:
                os.remove(os.path.join(EVENT_DIR, f))
            except: pass
            
    print("\n--- RESET COMPLETE ---")
    print("Now run 'run_visioncam.bat' to start fresh.")

if __name__ == "__main__":
    reset()
