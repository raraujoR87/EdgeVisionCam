import subprocess
import time
import sys

def main():
    processes = {
        "api": ["python", "core/api_internal/main.py"],
        "agent": ["python", "core/graph/agent.py"],
        "engine": ["python", "edge/vision_engine.py"],
        "admin_bot": ["python", "telegram_admin_bot.py"],
        "frigate_bridge": ["python", "edge/frigate_bridge.py"]
    }
    
    running = {}
    
    # Start all processes
    for name, cmd in processes.items():
        print(f"[ENTRYPOINT] Starting {name} process: {' '.join(cmd)}")
        try:
            running[name] = subprocess.Popen(cmd)
        except Exception as e:
            print(f"[ENTRYPOINT] CRITICAL: Failed to start {name} process: {e}")
            sys.exit(1)
        
    print("[ENTRYPOINT] All services launched. Monitoring...")
    
    try:
        while True:
            for name, proc in list(running.items()):
                ret = proc.poll()
                if ret is not None:
                    print(f"[ENTRYPOINT] WARNING: {name} process exited with code {ret}. Restarting...")
                    try:
                        running[name] = subprocess.Popen(processes[name])
                    except Exception as e:
                        print(f"[ENTRYPOINT] Failed to restart {name}: {e}")
            time.sleep(5)
    except KeyboardInterrupt:
        print("[ENTRYPOINT] Shutting down all processes...")
        for name, proc in running.items():
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        sys.exit(0)

if __name__ == "__main__":
    main()
