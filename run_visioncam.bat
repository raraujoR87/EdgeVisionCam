@echo off
:: Ensure we are in the correct directory regardless of where it was called from
cd /d %~dp0
TITLE VisionCam: Edge-Safe AI - Full Stack
COLOR 0B

echo ======================================================
echo   VISIONCAM: THE OMEGA BLUEPRINT (HARD RESTART)
echo ======================================================

:: 0. CLEANUP STALE PROCESSES
echo [CLEANUP] Terminating old sessions...
echo taskkill /F /FI "WINDOWTITLE eq VisionCam*" /T >nul 2>&1
echo taskkill /F /IM python.exe /T >nul 2>&1

:: 1. ENVIRONMENT CHECK
echo [CHECK] Verifying environment...
if not exist "venv" (
    echo [ERROR] Virtual Environment missing! Run setup first.
    pause
    exit
)

echo [INFO] Starting internal services bare-metal...

:: 2. BACKEND API (Port 8000)
echo [1/4] Launching FastAPI Data Bridge...
start "VisionCam: API" cmd /k ".\venv\Scripts\activate && python core/api_internal/main.py"

:: Wait for API to initialize DB
timeout /t 3 /nobreak >nul

:: 3. VISION ENGINE (YOLO-Pose)
echo [2/4] Initializing Biomechanical Vision Engine...
start "VisionCam: Vision Engine" cmd /k ".\venv\Scripts\activate && python edge/vision_engine.py"

:: 4. COGNITIVE BRAIN (LangGraph)
echo [3/4] Initializing LangGraph Orchestrator...
start "VisionCam: Brain" cmd /k ".\venv\Scripts\activate && python core/graph/agent.py"

:: 5. DASHBOARD (Port 3000)
echo [4/4] Launching Enterprise SOC Dashboard...
cd ui
start "VisionCam: UI Dashboard" cmd /k "set NEXT_PUBLIC_LOCAL_ONLY=true&& npm run dev"

echo ======================================================
echo   SYSTEM ONLINE: 
echo   - UI: http://localhost:3000
echo   - API: http://localhost:8000
echo   - (Close these windows manually to stop the system)
echo ======================================================
pause
