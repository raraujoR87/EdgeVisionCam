import os
import sys
import json
import time
import requests
import sqlite3
import cv2
import numpy as np
import httpx
from fastapi import FastAPI, Request, BackgroundTasks

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from core.database.db import QUEUE_DB_PATH

# Configuration
FRIGATE_URL = os.getenv("FRIGATE_URL", "http://127.0.0.1:5000")
EVENT_STORAGE = os.path.abspath(os.path.join(os.path.dirname(__file__), 'storage', 'events'))
os.makedirs(EVENT_STORAGE, exist_ok=True)

app = FastAPI(title="VisionCam Frigate Bridge")

SUSPECT_REID_CACHE = [] # In-memory cache for cross-camera Re-ID

def analyze_and_enqueue_clip(event_id: str, camera: str, label: str):
    clip_filename = f"frigate_{event_id}.mp4"
    clip_path = os.path.join(EVENT_STORAGE, clip_filename)
    
    # 1. Download clip from Frigate
    clip_url = f"{FRIGATE_URL}/api/events/{event_id}/clip.mp4"
    print(f"  [FRIGATE BRIDGE] Downloading clip for event {event_id} from {clip_url}...")
    try:
        r = requests.get(clip_url, stream=True, timeout=30)
        if r.status_code == 200:
            with open(clip_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            print(f"  [FRIGATE BRIDGE] Clip saved: {clip_path}")
        else:
            print(f"  [FRIGATE BRIDGE ERROR] Frigate returned status {r.status_code}")
            return
    except Exception as e:
        print(f"  [FRIGATE BRIDGE ERROR] Download failed: {e}")
        return

    # 2. Offline Biomechanical analysis (YOLO-Pose on the clip)
    try:
        from ultralytics import YOLO
        # Load local models
        model_pose = YOLO(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'yolo26n-pose.pt')))
        model_obj = YOLO(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'yolo26s.pt')))
        
        cap = cv2.VideoCapture(clip_path)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 20.0
        
        print(f"  [FRIGATE BRIDGE] Running offline YOLO-Pose analysis on {total_frames} frames...")
        
        has_concealment = False
        reasons = []
        suspicion_score = 0.0
        person_hist = None
        
        # Check every 3rd frame of the clip to save NPU/CPU
        frame_idx = 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            if frame_idx % 3 == 0:
                res_pose = model_pose(frame, verbose=False, conf=0.35)
                
                # Check wrists and hips distance, object overlap, etc.
                if len(res_pose) > 0 and res_pose[0].boxes is not None and len(res_pose[0].boxes) > 0:
                    kpts = res_pose[0].keypoints.xy.cpu().numpy()
                    bxs = res_pose[0].boxes.xyxy.cpu().numpy()
                    
                    for idx, k in enumerate(kpts):
                        # Extract HSV histogram once
                        if person_hist is None and idx < len(bxs):
                            box = bxs[idx].astype(int)
                            crop = frame[max(0, box[1]):min(frame.shape[0], box[3]), max(0, box[0]):min(frame.shape[1], box[2])]
                            if crop.size > 0:
                                try:
                                    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
                                    hist_h = cv2.calcHist([hsv], [0], None, [8], [0, 180])
                                    hist_s = cv2.calcHist([hsv], [1], None, [8], [0, 256])
                                    cv2.normalize(hist_h, hist_h, 0, 1, cv2.NORM_MINMAX)
                                    cv2.normalize(hist_s, hist_s, 0, 1, cv2.NORM_MINMAX)
                                    person_hist = np.concatenate([hist_h, hist_s]).flatten().tolist()
                                except Exception as hist_err:
                                    print(f"  [FRIGATE BRIDGE] HSV Hist failed: {hist_err}")

                        # Simple wrist below hip logic
                        if len(k) > 10:
                            lw_y, rw_y = k[9][1], k[10][1]
                            hip_y = k[11][1]
                            if lw_y > hip_y - 20 or rw_y > hip_y - 20:
                                has_concealment = True
                                if "Movimento de mão próxima ao bolso/quadril" not in reasons:
                                    reasons.append("Movimento de mão próxima ao bolso/quadril")
                                    suspicion_score += 0.35
                                
            frame_idx += 1
        cap.release()
        
        # ── Cross-Camera Re-ID check ──
        now = time.time()
        global SUSPECT_REID_CACHE
        # Clear entries older than 60 seconds
        SUSPECT_REID_CACHE = [item for item in SUSPECT_REID_CACHE if now - item['timestamp'] < 60.0]
        
        matched_pid = None
        best_match_val = -1.0
        
        if person_hist is not None:
            for item in SUSPECT_REID_CACHE:
                a = np.array(person_hist)
                b = np.array(item['hist'])
                norm_a = np.linalg.norm(a)
                norm_b = np.linalg.norm(b)
                if norm_a > 0 and norm_b > 0:
                    sim = np.dot(a, b) / (norm_a * norm_b)
                    if sim > 0.82 and sim > best_match_val:
                        best_match_val = sim
                        matched_pid = item['p_id']
            
            if matched_pid is not None:
                # Inherit/accumulate suspicion
                prev_susp = next(item['suspicion_score'] for item in SUSPECT_REID_CACHE if item['p_id'] == matched_pid)
                suspicion_score = min(1.0, suspicion_score + prev_susp * 0.40)
                reasons.append("Suspeito recorrente detectado em múltiplas câmeras (Re-ID HSV)")
                print(f"  [RE-ID MATCH] Suspeito associado ao ID P_{matched_pid} (similidade HSV: {best_match_val:.2f})")
        
        if matched_pid is None:
            matched_pid = int(time.time()) % 1000
            
        # Update cache
        if person_hist is not None:
            SUSPECT_REID_CACHE.append({
                'timestamp': now,
                'p_id': matched_pid,
                'hist': person_hist,
                'suspicion_score': suspicion_score
            })

        if len(reasons) == 0:
            reasons.append("Detecção de presença na gôndola via Frigate NVR")
            
        suspicion_score = min(1.0, suspicion_score + 0.3)
        risk_level = "high" if suspicion_score > 0.6 else "medium"
        
        # 3. Create Payload and insert into queue.db
        payload = {
            "type": "Behavioral_Theft",
            "p_id": matched_pid,
            "suspicion_score": round(float(suspicion_score), 2),
            "evidence_report": f"Frigate Event: {event_id} | Câmera: {camera} | Objeto: {label}",
            "video_duration_s": round(total_frames / fps, 1),
            "event_datetime": time.strftime("%d/%m/%Y %H:%M:%S", time.localtime()),
            "products": [label],
            "intent_analysis": {
                "intent_score": round(float(suspicion_score), 2),
                "risk_level": risk_level,
                "concealment_gesture": has_concealment,
                "reasons": reasons
            },
            "agent_state": "SUSPICIOUS"
        }
        
        conn = sqlite3.connect(QUEUE_DB_PATH)
        c = conn.cursor()
        c.execute(
            "INSERT INTO events (timestamp, video_path, payload_json, status, suspicion_score) VALUES (?,?,?,?,?)",
            (time.time(), clip_filename, json.dumps(payload), 'PENDING', suspicion_score)
        )
        conn.commit()
        conn.close()
        print(f"  [FRIGATE BRIDGE] Event enqueued for LangGraph: {clip_filename}")
        
    except Exception as e:
        print(f"  [FRIGATE BRIDGE ERROR] Analysis failed: {e}")

@app.post("/webhook/frigate")
async def frigate_webhook(request: Request, background_tasks: BackgroundTasks):
    try:
        body = await request.json()
        event_type = body.get("type", "")
        after = body.get("after", {})
        
        if event_type == "end" and after.get("has_clip", False):
            event_id = after.get("id")
            camera = after.get("camera", "camera_default")
            label = after.get("label", "objeto")
            
            background_tasks.add_task(analyze_and_enqueue_clip, event_id, camera, label)
            return {"status": "processing_queued", "event_id": event_id}
            
    except Exception as e:
        print(f"  [FRIGATE BRIDGE Webhook Error] {e}")
        
    return {"status": "ignored"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8090)
