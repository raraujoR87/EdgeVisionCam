import cv2
import numpy as np
import collections
import time
import os
import sys
import asyncio
import threading
import json
import httpx
from typing import Optional
from ultralytics import YOLO

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from core.database.db import get_system_db, get_queue_db, SYSTEM_DB_PATH
from core.security import get_internal_secret_sync
from shared.metrics import record_inference
from edge.local_agent import LocalAgent, VisionEvent, EventType

# ═══════════════════════════════════════════════════════════════════
# LOSS PREVENTION ENGINE V7.0 — GRAPH-BASED COOPERATIVE MULTI-AGENT SYSTEM
#
# Este sistema é composto por 4 agentes especializados baseados em grafos de estados:
#
# 1. YoloPerceptionAgent (DetectionAgentThread):
#    - Executa a inferência YOLO (Pose + Objetos) em tempo real em uma thread dedicada.
#    - Produz as coordenadas brutas da cena (boxes, keypoints, classes, confianças).
#
# 2. PoseBehaviorAgent (Continuous Behavior Analyzer):
#    - Monitora a pose do cliente de forma contínua em cada frame.
#    - Identifica gestos persistentes (mão no bolso, mão na gola, box swapping).
#    - Alimenta dinamicamente o score de suspeita da pessoa (trk.score).
#
# 3. InventoryCartAgent (Held/Basket Product Manager):
#    - Rastreia o estado e a posse dos produtos (HELD, MISSING, GONE, BASKET).
#    - Ajusta dinamicamente a tolerância de desaparecimento (gone_timeout) dos itens:
#      - Suspeita Baixa: 20 segundos (tempo de tolerância padrão).
#      - Suspeita Média (SUSPECT, score >= 0.30): reduz para 8 segundos.
#      - Suspeita Alta (ALERT, score >= 0.55): reduz para 3 segundos (evasão rápida).
#
# 4. SupervisorAgent (Orquestrador / Agente Local):
#    - Coordena os agentes locais, gerencia a gravação assíncrona de clipes de vídeo,
#      e faz a ponte cognitiva enviando as decisões críticas para o Gemini e Telegram.
# ═══════════════════════════════════════════════════════════════════

TARGET_W, TARGET_H = 640, 480
EVENT_STORAGE = os.path.join(os.path.dirname(__file__), 'storage', 'events')
os.makedirs(EVENT_STORAGE, exist_ok=True)

# ── Timing ──
MISSING_TIMEOUT  = 15.0   # Seconds without detection ANYWHERE in scene → MISSING
GONE_TIMEOUT     = 20.0   # Seconds missing → CONFIRMED GONE → Gemini
ALERT_COOLDOWN   = 45.0
WRIST_LINK_PX    = 130    # Wrist-to-object distance for "holding"
MIN_CONFIRM_FRAMES = 5   # Frames to confirm pickup (filters 1-frame phantoms)
MIN_SCENE_CONFIRM  = 3   # Frames of scene visibility to confirm reappear
MIN_ACTIVE_FRAMES  = 15  # Minimum active frames of detection to trigger alert
MIN_SCENE_PREEXIST = 3   # Object class must exist in scene for N frames before pickup is valid
PENDING_EXPIRE     = 2.0 # Seconds before a pending product expires

# ── YOLO Filtering ──
MIN_OBJ_AREA     = 300    # Reduced: remote controls are small (~400px²)
MIN_OBJ_CONF     = 0.25

PRODUCT_CLASSES = {
    39: 'garrafa', 41: 'copo', 65: 'controle', 67: 'celular',
    73: 'livro', 76: 'tesoura', 77: 'pelucia', 79: 'escova',
}
BAG_CLASSES = {24: 'mochila', 26: 'bolsa', 28: 'mala'}
BLOCKED_CLASSES = {15, 27, 56, 57, 59, 60, 62, 78}


class HeldProduct:
    """One product class being tracked for a specific person."""
    def __init__(self, cls_id, cls_name):
        self.cls_id = cls_id
        self.cls_name = cls_name
        self.acquired_at = time.time()
        self.last_seen = time.time()
        self.last_position = None
        self.first_position = None
        self.status = 'HELD'     # HELD → MISSING → GONE → CLEARED
        self.missing_since = None
        self.alerted = False
        self.seen_count = MIN_CONFIRM_FRAMES      # Initial confirmation frames
        # Trajectory: last N positions of the product (for direction analysis)
        self.position_history = collections.deque(maxlen=30)
        # Pose data captured at the MOMENT of disappearance (t=0)
        self.disappearance_kpts = None
        self.disappearance_wrist_history = None
        self.disappearance_product_pos = None
        self.disappearance_ring_len = None  # Ring buffer length at t=0

    def see(self, pos, trk=None):
        """Called when this product class is detected near the person's wrist."""
        self.last_seen = time.time()
        self.last_position = pos
        self.seen_count += 1
        if pos:
            self.position_history.append(pos)
            if self.first_position is None:
                self.first_position = pos
        if trk:
            self.disappearance_kpts = trk.last_kpts
            self.disappearance_wrist_history = list(trk.wrist_history)
            self.disappearance_product_pos = pos
        if self.status in ('MISSING', 'GONE', 'BASKET'):
            self.status = 'HELD'
            self.missing_since = None

    def tick(self, now, trk=None, ring_len=0):
        """Called every frame to update status based on time."""
        if self.status == 'HELD':
            if now - self.last_seen > MISSING_TIMEOUT:
                self.status = 'MISSING'
                self.missing_since = now
                # Capture pose + ring index at the MOMENT of disappearance
                self.disappearance_ring_len = ring_len
                if trk and self.disappearance_kpts is None:
                    self.disappearance_kpts = trk.last_kpts
                    self.disappearance_wrist_history = list(trk.wrist_history)
                    self.disappearance_product_pos = self.last_position
        elif self.status == 'MISSING':
            gone_threshold = trk.get_gone_timeout() if trk else GONE_TIMEOUT
            if now - self.missing_since > gone_threshold:
                self.status = 'GONE'

    @property
    def missing_elapsed(self):
        if self.missing_since:
            return time.time() - self.missing_since
        return 0.0


class PersonTracker:
    """Tracks one person and the products they're holding."""
    def __init__(self, pid):
        self.pid = pid
        self.first_seen = time.time()
        self.last_seen = time.time()
        self.bbox = None
        self.products = {}  # cls_id → HeldProduct
        self.pending_products = {}  # cls_id → {count, first, last, name, positions}
        self.scene_confirm = {}  # cls_id → consecutive frame count for scene reappear
        self.first_pickup_time = None  # When first product was confirmed (for video)

        # Head scan
        self.nose_buf = collections.deque(maxlen=60)

        # Score
        self.score = 0.0
        self.evidence = []
        self.alert_level = 'NORMAL'
        self.alerted_products = set()
        self.last_alert_t = 0.0

        # Pose intent data (for agent)
        self.last_kpts = None
        self.wrist_history = collections.deque(maxlen=20)
        self.exit_detected = False
        self.exit_direction = None

    def reset_after_alert(self):
        """Fast reset: clear tracking state so engine can immediately process new events.
        Keeps: pid, last_seen, bbox, last_alert_t, alerted_products, exit data."""
        self.products.clear()
        self.pending_products.clear()
        self.scene_confirm.clear()
        self.first_pickup_time = None
        self.score = 0.0
        self.evidence.clear()
        self.alert_level = 'NORMAL'
        if hasattr(self, 'gesture_start'):
            self.gesture_start.clear()
            self.gesture_alerted.clear()
            self.gesture_cooldown.clear()
        # NOTE: last_alert_t and alerted_products are NOT cleared (cooldown protection)

    def add_evidence(self, desc, delta):
        self.score = min(1.0, self.score + delta)
        self.evidence.append((time.time(), desc, delta))
        self._sync()

    def _sync(self):
        if   self.score >= 0.55: self.alert_level = 'ALERT'
        elif self.score >= 0.30: self.alert_level = 'SUSPECT'
        elif self.score >= 0.15: self.alert_level = 'OBSERVATION'
        else:                    self.alert_level = 'NORMAL'

    def get_gone_timeout(self):
        """Dynamic timeout based on suspicion score (cooperative multi-agent logic)."""
        if self.score >= 0.55:
            return 3.0    # Alert: high suspicion, check almost immediately
        elif self.score >= 0.30:
            return 8.0    # Suspect: medium suspicion, check fast
        return 20.0       # Normal: low/no suspicion, standard timeout

    def evidence_report(self, video_duration=35.0):
        """Generate evidence report with timestamps relative to the VIDEO.
        Video covers the last `video_duration` seconds before the alert.
        So a timestamp at t=now maps to video second = video_duration.
        A timestamp at t=now-10 maps to video second = video_duration-10.
        """
        now = time.time()
        lines = [f"Duracao do video: {video_duration:.0f}s"]
        lines.append(f"Score de Suspeita: {self.score:.2f}")
        for t, desc, d in self.evidence:
            # Convert to video-relative timestamp
            secs_ago = now - t
            video_sec = max(0, video_duration - secs_ago)
            lines.append(f"  [video {video_sec:5.1f}s] {desc} ({'+' if d>=0 else ''}{d:.2f})")
        return "\n".join(lines)

    @property
    def color(self):
        return {'NORMAL': (0,200,0), 'OBSERVATION': (0,230,230),
                'SUSPECT': (0,165,255), 'ALERT': (0,0,255)}[self.alert_level]


class LossPreventionEngine:
    def __init__(self):
        self.persons = {}
        self.audit = collections.deque(maxlen=14)
        self.recording_pids = set()  # PIDs currently being recorded
        self.agent: Optional[LocalAgent] = None  # Set after agent creation
        self._current_frame = None  # Updated each inference frame
        # Scene-level class history: tracks how many recent frames each class has been seen
        self.scene_class_history = {}  # cls_id → deque of timestamps

    def set_agent(self, agent: LocalAgent):
        self.agent = agent

    def _emit(self, event_type: EventType, pid: int, cls_name: str,
              frame=None, score=0.0, evidence=None,
              kpts=None, product_last_pos=None, person_bbox=None,
              wrist_history=None, product_trajectory=None,
              frame_shape=None, head_scanning=False,
              disappearance_ring_len=0, pickup_time=0.0):
        """Emit a typed event to the local agent with rich analysis data."""
        if self.agent is None:
            return
        evt = VisionEvent(
            type=event_type, pid=pid, cls_name=cls_name,
            timestamp=time.time(), frame=frame.copy() if frame is not None else None,
            score=score, evidence=evidence or [],
            kpts=kpts, product_last_pos=product_last_pos,
            person_bbox=person_bbox, wrist_history=wrist_history,
            product_trajectory=product_trajectory,
            frame_shape=frame_shape, head_scanning=head_scanning,
            disappearance_ring_len=disappearance_ring_len,
            pickup_time=pickup_time
        )
        try:
            self.agent.event_queue.put_nowait(evt)
        except Exception:
            pass

    def log(self, msg):
        entry = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.audit.append(entry)
        print(f"  [V6] {msg}")

    def _person(self, pid):
        if pid not in self.persons:
            self.persons[pid] = PersonTracker(pid)
        self.persons[pid].last_seen = time.time()
        return self.persons[pid]

    def _head_scanning(self, trk, kpts):
        nose = kpts.get('nose', (0,0))
        ls, rs = kpts.get('ls', (0,0)), kpts.get('rs', (0,0))
        if nose[0] <= 0 or ls[0] <= 0 or rs[0] <= 0:
            return False
        now = time.time()
        rel_x = nose[0] - (ls[0]+rs[0])/2
        trk.nose_buf.append((now, rel_x))
        recent = [(t,x) for t,x in trk.nose_buf if now-t < 5.0]
        if len(recent) < 10:
            return False
        changes = sum(1 for i in range(2, len(recent))
                      if (recent[i-1][1]-recent[i-2][1])*(recent[i][1]-recent[i-1][1]) < 0
                      and abs(recent[i][1]-recent[i-1][1]) > 5)
        return changes >= 4

    def _analyze_continuous_pose(self, trk, kpts, now):
        ls = kpts.get('ls', (0,0)); rs = kpts.get('rs', (0,0))
        lh = kpts.get('lh', (0,0)); rh = kpts.get('rh', (0,0))
        lw = kpts.get('lw', (0,0)); rw = kpts.get('rw', (0,0))
        
        if not (ls[0] > 0 and rs[0] > 0):
            return
            
        sw = np.linalg.norm(np.array(ls) - np.array(rs))
        if sw < 10:
            return
            
        if not hasattr(trk, 'gesture_start'):
            trk.gesture_start = {}
            trk.gesture_alerted = set()
            trk.gesture_cooldown = {}

        def dist(pt1, pt2):
            if pt1[0] <= 0 or pt2[0] <= 0:
                return 9999
            return np.linalg.norm(np.array(pt1) - np.array(pt2))

        active_gestures = set()

        # 1. Pocket check
        pocket_prox = False
        for side, hand, hip in [('L', lw, lh), ('R', rw, rh)]:
            if hand[0] > 0 and hip[0] > 0:
                if dist(hand, hip) / sw < 0.70:
                    pocket_prox = True
                    break
        if pocket_prox:
            active_gestures.add('bolso')

        # 2. Collar check
        collar_prox = False
        for side, hand, shoulder in [('L', lw, ls), ('R', rw, rs)]:
            if hand[0] > 0 and shoulder[0] > 0:
                if dist(hand, shoulder) / sw < 0.40:
                    collar_prox = True
                    break
        if collar_prox:
            active_gestures.add('gola')

        # 3. Wrists close check
        if lw[0] > 0 and rw[0] > 0:
            if dist(lw, rw) / sw < 0.35:
                active_gestures.add('maos_juntas')

        # 4. Body Shield Check (Oclusão Traseira)
        if ls[0] > 0 and rs[0] > 0:
            is_back_to_camera = ls[0] < rs[0]
            nose = kpts.get('nose', (0,0))
            if is_back_to_camera and nose[0] <= 0:
                le = kpts.get('le', (0,0)); re = kpts.get('re', (0,0))
                elbow_dist = dist(le, re) if (le[0] > 0 and re[0] > 0) else 9999
                if elbow_dist / sw < 0.80:
                    active_gestures.add('escudo_corporal')

        # Process gestures
        gestures_definitions = {
            'bolso': ('bolso/quadril', 1.5, 0.20, "Mão persistente próxima ao bolso/quadril"),
            'gola': ('gola/peito', 1.2, 0.20, "Mão persistente próxima à gola/peito"),
            'maos_juntas': ('maos_juntas', 2.0, 0.20, "Manipulação persistente com ambas as mãos"),
            'escudo_corporal': ('escudo_corporal', 3.0, 0.35, "Movimento suspeito de ocultação sob oclusão (costas para a câmera)")
        }

        for gesture, (desc_short, duration_threshold, score_delta, desc_full) in gestures_definitions.items():
            if gesture in active_gestures:
                if trk.gesture_cooldown.get(gesture, 0) > now:
                    continue
                if gesture not in trk.gesture_start:
                    trk.gesture_start[gesture] = now
                elif now - trk.gesture_start[gesture] >= duration_threshold:
                    if gesture not in trk.gesture_alerted:
                        trk.add_evidence(desc_full, score_delta)
                        self.log(f"P_{trk.pid}: Gesto persistente detectado: {desc_full} [+{score_delta:.2f}] (Score: {trk.score:.2f})")
                        trk.gesture_alerted.add(gesture)
                        trk.gesture_cooldown[gesture] = now + 15.0
            else:
                trk.gesture_start.pop(gesture, None)
                trk.gesture_alerted.discard(gesture)

    def process(self, active_pids, person_kpts, person_bboxes,
                wrist_positions, valid_products, scene_class_set, receptacles,
                cam_ring_len=0):
        """
        valid_products: [(cx, cy, cls_id, cls_name), ...]
        scene_class_set: set of cls_ids detected ANYWHERE in the frame
        """
        alerts = []
        now = time.time()
        start_recording = set()

        # ── 0. Update scene class history (for phantom object filtering) ──
        for cls_id in scene_class_set:
            if cls_id not in self.scene_class_history:
                self.scene_class_history[cls_id] = collections.deque(maxlen=30)
            self.scene_class_history[cls_id].append(now)
        # Expire old entries (older than 5 seconds)
        for cls_id in list(self.scene_class_history.keys()):
            while self.scene_class_history[cls_id] and now - self.scene_class_history[cls_id][0] > 5.0:
                self.scene_class_history[cls_id].popleft()
            if not self.scene_class_history[cls_id]:
                del self.scene_class_history[cls_id]

        for pid in active_pids:
            trk = self._person(pid)
            trk.bbox = person_bboxes.get(pid)
            kpts = person_kpts.get(pid, {})
            wrists = wrist_positions.get(pid, [])

            # Store pose data for intent analysis
            trk.last_kpts = kpts
            if len(wrists) >= 2:
                trk.wrist_history.append((
                    (float(wrists[0][0]), float(wrists[0][1])),
                    (float(wrists[1][0]), float(wrists[1][1]))
                ))

            # ── Continuous Pose Behavior Analyzer (NOVO V6.9) ──
            if trk.products and kpts:
                self._analyze_continuous_pose(trk, kpts, now)

            # ── 1. Check which product classes are near this person's wrists ──
            # Threshold de Proximidade Espacial Adaptativo (NOVO V6.7)
            ls = kpts.get('ls', (0,0))
            rs = kpts.get('rs', (0,0))
            if ls[0] > 0 and rs[0] > 0:
                sw = np.linalg.norm(np.array(ls) - np.array(rs))
                wrist_threshold = max(80.0, min(220.0, sw * 1.3))
            else:
                wrist_threshold = WRIST_LINK_PX

            near_classes = {}  # cls_id → (cx, cy, cls_name)
            for wx, wy in wrists:
                if wx <= 0:
                    continue
                for p_item in valid_products:
                    px, py, cls_id, cls_name = p_item[0], p_item[1], p_item[2], p_item[3]
                    d = np.linalg.norm(np.array([wx, wy]) - np.array([px, py]))
                    if d < wrist_threshold:
                        near_classes[cls_id] = (px, py, cls_name)

            # ── 2. CONFIRMED PICKUP (requires multiple frames) ──
            for cls_id, (px, py, cls_name) in near_classes.items():
                if cls_id in trk.products:
                    # Already confirmed — update position
                    prod = trk.products[cls_id]
                    was_inactive = prod.status in ('MISSING', 'GONE', 'BASKET')
                    prod.see((px, py), trk=trk)
                    if was_inactive:
                        trk.alerted_products.discard(cls_id)
                        elapsed = prod.missing_elapsed if prod.missing_since else 0.0
                        self.log(f"P_{pid}: [{cls_name}] REAPARECEU na mao ({elapsed:.0f}s)")
                        self._emit(EventType.REAPPEAR, pid, cls_name)
                else:
                    # Pending confirmation — count frames
                    if cls_id not in trk.pending_products:
                        is_in_guard_zone = True
                        if active_zones:
                            shifted_zones = [z + np.array([camera_drift_dx, camera_drift_dy], dtype=np.int32) for z in active_zones]
                            is_in_guard_zone = any(cv2.pointPolygonTest(z_shifted, (float(px), float(py)), False) >= 0 for z_shifted in shifted_zones)
                        trk.pending_products[cls_id] = {
                            'count': 1, 'first': now, 'last': now,
                            'name': cls_name, 'positions': [(px, py)],
                            'started_in_guard_zone': is_in_guard_zone
                        }
                    else:
                        pp = trk.pending_products[cls_id]
                        pp['count'] += 1
                        pp['last'] = now
                        pp['positions'].append((px, py))

                        # CONFIRMED after N frames
                        if pp['count'] >= MIN_CONFIRM_FRAMES:
                            if not pp.get('started_in_guard_zone', True):
                                self.log(f"P_{pid}: Descartado [{cls_name}] - Item iniciado fora da zona de guarda (item pessoal).")
                                del trk.pending_products[cls_id]
                                continue

                            # ── Scene Preexistence Check ──
                            # Object class must have been seen in the scene for at least
                            # MIN_SCENE_PREEXIST frames before we accept a pickup.
                            # This filters phantom objects that appear for a brief moment
                            # due to camera angle but don't actually exist in the scene.
                            scene_count = len(self.scene_class_history.get(cls_id, []))
                            if scene_count < MIN_SCENE_PREEXIST:
                                self.log(f"P_{pid}: Descartado [{cls_name}] - Objeto fantasma (cena: {scene_count} < {MIN_SCENE_PREEXIST} frames)")
                                del trk.pending_products[cls_id]
                                continue

                            # ── Label Jitter Suppression ──
                            # If another product was picked up recently (<8s) within a short distance (<220px),
                            # we assume it is a label oscillation for the same physical object.
                            # We remove/suppress the older one to avoid duplicate theft triggers.
                            duplicate_ids = []
                            for old_cls_id, old_prod in list(trk.products.items()):
                                time_diff = now - old_prod.acquired_at
                                if time_diff < 8.0:
                                    if old_prod.last_position:
                                        dist = np.linalg.norm(np.array(old_prod.last_position) - np.array([px, py]))
                                        if dist < 220.0:
                                            self.log(f"P_{pid}: Detectado jitter de rotulo. Substituindo [{old_prod.cls_name}] por [{cls_name}] (dist: {dist:.1f}px)")
                                            duplicate_ids.append(old_cls_id)
                            
                            for did in duplicate_ids:
                                del trk.products[did]
                                trk.alerted_products.discard(did)

                            trk.products[cls_id] = HeldProduct(cls_id, cls_name)
                            # Seed position history from pending
                            for pos in pp['positions']:
                                trk.products[cls_id].position_history.append(pos)
                            trk.products[cls_id].see((px, py), trk=trk)
                            trk.alerted_products.discard(cls_id)
                            if trk.first_pickup_time is None:
                                trk.first_pickup_time = time.time()
                            start_recording.add(pid)
                            self.log(f"P_{pid}: Pegou [{cls_name}] -> gravacao iniciada ({pp['count']}f confirmado)")
                            self._emit(EventType.PICKUP, pid, cls_name, frame=None)
                            del trk.pending_products[cls_id]

            # Expire pending products not seen for PENDING_EXPIRE seconds
            for cls_id in list(trk.pending_products.keys()):
                if now - trk.pending_products[cls_id]['last'] > PENDING_EXPIRE:
                    del trk.pending_products[cls_id]

            # ── 2b. Scene-level check with confirmation ──
            for cls_id, prod in trk.products.items():
                if cls_id in scene_class_set:
                    # Count consecutive scene frames
                    trk.scene_confirm[cls_id] = trk.scene_confirm.get(cls_id, 0) + 1
                    if trk.scene_confirm[cls_id] >= MIN_SCENE_CONFIRM:
                        was_inactive = prod.status in ('MISSING', 'GONE', 'BASKET')
                        prod.see(prod.last_position, trk=trk)
                        if was_inactive:
                            trk.alerted_products.discard(cls_id)
                            self.log(f"P_{pid}: [{prod.cls_name}] visivel na cena -> timer resetado ({trk.scene_confirm[cls_id]}f)")
                            self._emit(EventType.REAPPEAR, pid, prod.cls_name)
                else:
                    trk.scene_confirm[cls_id] = 0  # Reset counter

            # ── 3. Tick all products: check for missing/gone ──
            for cls_id, prod in list(trk.products.items()):
                prev = prod.status
                prod.tick(now, trk, ring_len=cam_ring_len)

                if prod.status == 'MISSING' and prev == 'HELD':
                    self.log(f"P_{pid}: [{prod.cls_name}] NÃO VISÍVEL — contagem regressiva 20s")

                elif prod.status == 'MISSING' and prev == 'MISSING':
                    # Log countdown every 5 seconds
                    elapsed = prod.missing_elapsed
                    if int(elapsed) % 5 == 0 and int(elapsed) > 0:
                        remaining = GONE_TIMEOUT - elapsed
                        if remaining > 0 and int(elapsed * 20) % 20 == 0:
                            pass  # Avoid spam, log is below

                elif prod.status == 'GONE' and prev == 'MISSING':
                    # Require minimum sustained interaction (checked via global MIN_ACTIVE_FRAMES)
                    if prod.seen_count < MIN_ACTIVE_FRAMES:
                        self.log(f"P_{pid}: Descartado [{prod.cls_name}] - Pouca interacao (frames: {prod.seen_count} < {MIN_ACTIVE_FRAMES})")
                        del trk.products[cls_id]
                        continue

                    # === CONFIRMED GONE -- 20 seconds without reappearing ===
                    self.log(f"P_{pid}: *** [{prod.cls_name}] DESAPARECEU (20s) ***")

                    # Score
                    trk.add_evidence(f"{prod.cls_name} desapareceu por 20 segundos", 0.40)

                    # Is this class completely absent from the scene?
                    if cls_id not in scene_class_set:
                        trk.add_evidence(f"Nenhum(a) {prod.cls_name} visivel na cena", 0.20)
                        self.log(f"P_{pid}: Cena SEM [{prod.cls_name}] [+0.20]")

                    # Near a bag?
                    if trk.bbox and receptacles:
                        bcx = (trk.bbox[0]+trk.bbox[2])//2
                        bcy = (trk.bbox[1]+trk.bbox[3])//2
                        for bx1,by1,bx2,by2 in receptacles:
                            if bx1-50 < bcx < bx2+50 and by1-50 < bcy < by2+50:
                                trk.add_evidence("Bolsa/mochila proxima", 0.15)
                                self.log(f"P_{pid}: Bolsa proxima [+0.15]")
                                break

                    # Emit MISSING event with rich data for intent analysis
                    if cls_id not in trk.alerted_products:
                        trk.alerted_products.add(cls_id)
                        
                        # Cooldown check
                        if now - trk.last_alert_t < ALERT_COOLDOWN:
                            self.log(f"P_{pid}: Alerta de [{prod.cls_name}] SUPRIMIDO por cooldown ({now - trk.last_alert_t:.1f}s < {ALERT_COOLDOWN}s)")
                        else:
                            trk.last_alert_t = now
                            has_scanning = any("Vigil" in e for e in trk.evidence)
                            self._emit(EventType.MISSING, pid, prod.cls_name,
                                       score=trk.score, evidence=list(trk.evidence),
                                       frame=self._current_frame,
                                       kpts=prod.disappearance_kpts or trk.last_kpts,
                                       product_last_pos=prod.disappearance_product_pos or prod.last_position,
                                       person_bbox=trk.bbox,
                                       wrist_history=prod.disappearance_wrist_history or list(trk.wrist_history),
                                       product_trajectory=list(prod.position_history),
                                       frame_shape=(self._current_frame.shape[:2] if self._current_frame is not None else None),
                                       head_scanning=has_scanning,
                                       disappearance_ring_len=prod.disappearance_ring_len or cam_ring_len,
                                       pickup_time=trk.first_pickup_time or time.time())
                            self.log(f"P_{pid}: -> AGENTE (analise de intencao v2)")


            # ── 4. Head scan (max +0.15 total, only as bonus) ──
            if self._head_scanning(trk, kpts):
                scan_sum = sum(d for _, desc, d in trk.evidence if 'olhando' in desc)
                if scan_sum < 0.15 and trk.products:  # Only when holding something
                    trk.add_evidence("Vigilância (olhando ao redor)", 0.10)
                    self.log(f"P_{pid}: Vigilância [+0.10]")

        # Recording management
        self.recording_pids.update(start_recording)

        # ── 5. Detect exit direction (PERSON_EXIT) ──
        for pid in list(self.persons.keys()):
            trk = self.persons[pid]
            if pid not in active_pids and not trk.exit_detected:
                # ONLY track exits for people who triggered at least one theft alert
                if len(trk.alerted_products) > 0:
                    elapsed = now - trk.last_seen
                    if elapsed >= 1.0 and trk.bbox:
                        x1, y1, x2, y2 = trk.bbox
                        cx = (x1 + x2) / 2
                        margin = 90
                        is_left = (x1 < margin) or (cx < margin)
                        is_right = (x2 > TARGET_W - margin) or (cx > TARGET_W - margin)
                        
                        if is_left or is_right:
                            direction = 'left' if is_left else 'right'
                            trk.exit_detected = True
                            trk.exit_direction = direction
                            self.log(f"P_{pid}: Rota de fuga identificada: {direction.upper()} (bbox: {trk.bbox})")
                            self._emit(EventType.PERSON_EXIT, pid, cls_name=direction, person_bbox=trk.bbox)

        # Clean up persons gone for > 30s
        # Clean up persons gone for > 30s
        for pid in list(self.persons.keys()):
            if pid not in active_pids and now - self.persons[pid].last_seen > 30:
                # Person left — check if they had products and if suspicion is high enough
                trk = self.persons[pid]
                if trk.score >= 0.30:
                    for cls_id, prod in trk.products.items():
                        if cls_id not in trk.alerted_products:
                            self.log(f"P_{pid}: SAIU com [{prod.cls_name}] ({prod.status})! (Score: {trk.score:.2f})")
                            trk.alerted_products.add(cls_id)
                            
                            # Cooldown check
                            if now - trk.last_alert_t < ALERT_COOLDOWN:
                                self.log(f"P_{pid}: Alerta de saida para [{prod.cls_name}] SUPRIMIDO por cooldown ({now - trk.last_alert_t:.1f}s < {ALERT_COOLDOWN}s)")
                            else:
                                trk.last_alert_t = now
                                self._emit(EventType.PERSON_LEFT, pid, prod.cls_name,
                                           score=trk.score, evidence=list(trk.evidence),
                                           frame=self._current_frame,
                                           kpts=trk.last_kpts,
                                           product_last_pos=prod.last_position,
                                           person_bbox=trk.bbox,
                                           wrist_history=list(trk.wrist_history))
                else:
                    self.log(f"P_{pid}: Limpeza silenciosa de saida (Score: {trk.score:.2f} < 0.30)")
                self.recording_pids.discard(pid)
                del self.persons[pid]

        return alerts, start_recording


# ═══════════════════════════════════════════════════════════════════
# Infrastructure
# ═══════════════════════════════════════════════════════════════════

engine = None  # Created in inference_task with agent connected
agent = None
detection_queue = None
latest_raw_frame = None
latest_processed_frame = None
active_zones = []
camera_drift_dx = 0
camera_drift_dy = 0
http_client = httpx.AsyncClient(base_url="http://127.0.0.1:8000", timeout=0.5)

# Segredo compartilhado com a API para os endpoints /api/internal/*. Quem o
# gera e a API, no startup — e a engine pode subir antes dela, entao a leitura
# e preguicosa e se repete ate o valor aparecer no banco.
_internal_secret = ""


def internal_headers():
    """Headers de autenticacao interna, recarregando o segredo se necessario."""
    global _internal_secret
    if not _internal_secret:
        _internal_secret = get_internal_secret_sync(SYSTEM_DB_PATH)
    return {"X-Internal-Token": _internal_secret} if _internal_secret else {}

# Full-FPS recording buffer: camera thread writes here at full camera FPS
# This ensures saved videos play at real-time speed
cam_fps = 20.0
cam_ring = collections.deque(maxlen=1800)  # ~60s at 30fps
cam_ring_lock = threading.Lock()


class VideoCaptureThread(threading.Thread):
    def __init__(self, rtsp_url):
        super().__init__()
        self.rtsp_url = rtsp_url
        self.daemon = True
        self.running = True

    def run(self):
        global latest_raw_frame, cam_fps
        while self.running:
            if isinstance(self.rtsp_url, int):
                cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_DSHOW)
            else:
                cap = cv2.VideoCapture(self.rtsp_url)
            
            # Força o buffer do OpenCV para 1 frame para evitar lag de RTSP
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not cap.isOpened():
                print(f"  [CAM] Falha: {self.rtsp_url}")
                time.sleep(3); continue
            reported_fps = cap.get(cv2.CAP_PROP_FPS)
            if reported_fps > 0:
                cam_fps = reported_fps
            print(f"  [CAM] Conectado: {self.rtsp_url} ({cam_fps:.0f}fps)")
            fps_t0 = time.time()
            fps_count = 0
            while self.running and cap.isOpened():
                ret, frame = cap.read()
                if ret:
                    resized = cv2.resize(frame, (TARGET_W, TARGET_H))
                    latest_raw_frame = resized
                    with cam_ring_lock:
                        cam_ring.append(resized.copy())
                    # Measure real FPS every 100 frames
                    fps_count += 1
                    if fps_count >= 100:
                        elapsed = time.time() - fps_t0
                        if elapsed > 0:
                            cam_fps = fps_count / elapsed
                        fps_t0 = time.time()
                        fps_count = 0
                else:
                    cap.release(); break
            time.sleep(1)


def save_video_worker(pid, score, evidence_list, first_seen_t):
    """Save video from the full-FPS camera ring buffer."""
    global cam_fps
    ts = int(time.time())
    fname = f"event_{ts}_p{pid}.mp4"
    vpath = os.path.join(EVENT_STORAGE, fname)

    # Grab frames from the full-FPS camera buffer
    with cam_ring_lock:
        all_frames = list(cam_ring)

    # Ensure minimum 20 seconds of video
    fps = max(5, int(cam_fps))
    min_frames = fps * 20
    if len(all_frames) < min_frames:
        print(f"  [REC] Aviso: apenas {len(all_frames)} frames ({len(all_frames)/fps:.0f}s)")

    # Use the last 35 seconds (or all available)
    max_frames = fps * 35
    frames_to_save = all_frames[-max_frames:] if len(all_frames) > max_frames else all_frames

    duration = len(frames_to_save) / fps
    out = cv2.VideoWriter(vpath, cv2.VideoWriter_fourcc(*'mp4v'), fps, (TARGET_W, TARGET_H))
    for f in frames_to_save:
        out.write(f)
    out.release()
    print(f"  [REC] Salvo: {fname} ({len(frames_to_save)} frames, {fps}fps, {duration:.1f}s)")

    # Build evidence report with video-relative timestamps
    now = time.time()
    report_lines = [f"Duracao do video: {duration:.0f}s | Score: {score:.2f}"]
    for t, desc, d in evidence_list:
        secs_ago = now - t
        video_sec = max(0, duration - secs_ago)
        report_lines.append(f"  [video {video_sec:5.1f}s] {desc} ({'+' if d>=0 else ''}{d:.2f})")
    report = "\n".join(report_lines)

    async def register():
        try:
            db = await get_queue_db()
            payload = json.dumps({"type": "Behavioral_Theft", "p_id": int(pid),
                                  "suspicion_score": round(score, 2),
                                  "evidence_report": report,
                                  "video_duration_s": round(duration, 1)})
            await db.execute(
                "INSERT INTO events (timestamp, video_path, payload_json, status) VALUES (?,?,?,?)",
                (ts, fname, payload, 'PENDING'))
            await db.commit(); await db.close()
        except Exception as e:
            print(f"  [DB ERROR] {e}")
    asyncio.run(register())


async def stream_task():
    global latest_processed_frame, latest_raw_frame, _internal_secret
    while True:
        frame = latest_processed_frame if latest_processed_frame is not None else latest_raw_frame
        if frame is not None:
            try:
                _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 55])
                resp = await http_client.post(
                    "/api/internal/frame", content=buf.tobytes(), headers=internal_headers()
                )
                if resp.status_code == 401:
                    # Segredo ausente ou trocado (ex.: banco recriado):
                    # forca a releitura na proxima volta do laco.
                    _internal_secret = ""
            except Exception:
                pass
        await asyncio.sleep(0.04)


# ═══════════════════════════════════════════════════════════════════
# Main Inference Loop
# ═══════════════════════════════════════════════════════════════════

class DetectionAgentThread(threading.Thread):
    def __init__(self, loop, queue_ref):
        super().__init__()
        self.loop = loop
        self.queue_ref = queue_ref
        self.daemon = True
        self.running = True

    def run(self):
        t0 = time.time()
        # Suporta carregamento dinâmico de grafos da NPU (.nb/.nbg) no Radxa
        pose_model_path = os.getenv("POSE_MODEL_PATH", "yolo26n-pose.pt")
        obj_model_path = os.getenv("OBJ_MODEL_PATH", "yolo26s.pt")

        def load_model(path):
            if path.endswith(('.nb', '.nbg')):
                from edge.vivante_pose_engine import VivantePoseEngine
                return VivantePoseEngine(path)
            else:
                from ultralytics import YOLO
                return YOLO(path)

        print(f"  [V6] [DETECT-AGENT] Carregando modelo pose: {pose_model_path}...")
        model_pose = load_model(pose_model_path)
        print(f"  [V6] [DETECT-AGENT] Pose carregado em {time.time()-t0:.1f}s")

        t1 = time.time()
        print(f"  [V6] [DETECT-AGENT] Carregando modelo objetos: {obj_model_path}...")
        model_obj = load_model(obj_model_path)
        print(f"  [V6] [DETECT-AGENT] Objetos carregado em {time.time()-t1:.1f}s")

        # ── WARMUP: first inference is always slow (JIT/CUDA compilation) ──
        print("  [V6] [DETECT-AGENT] Warmup (primeira inferencia)...")
        t2 = time.time()
        dummy = np.zeros((TARGET_H, TARGET_W, 3), dtype=np.uint8)
        model_pose.track(dummy, imgsz=320, persist=True, verbose=False, conf=0.35, tracker="botsort.yaml")
        model_obj(dummy, imgsz=320, verbose=False, conf=0.20)
        print(f"  [V6] [DETECT-AGENT] Warmup completo em {time.time()-t2:.1f}s")

        # Signal ready to API
        async def signal_ready():
            try:
                await http_client.post(
                    "/api/internal/engine-ready", content=b"ok", headers=internal_headers()
                )
            except Exception:
                pass
        asyncio.run_coroutine_threadsafe(signal_ready(), self.loop)

        print(f"  [V6] [DETECT-AGENT] YOLO26 pronto — total: {time.time()-t0:.1f}s")

        # Camera Drift variables for stabilization
        ref_template = None
        ref_pos = (280, 200) # x, y (top-left of 80x80 crop)
        dx_smooth = 0.0
        dy_smooth = 0.0
        drift_calibrated = False
        frame_counter = 0

        # Frame rate limiter for NPU/CPU efficiency
        last_inference = 0
        inference_interval = 0.200 # 200ms -> 5 FPS (highly efficient)

        while self.running:
            try:
                now = time.time()
                if now - last_inference < inference_interval:
                    time.sleep(0.015)
                    continue

                if latest_raw_frame is None:
                    time.sleep(0.01)
                    continue

                frame = latest_raw_frame.copy()
                last_inference = now
                frame_counter += 1

                # ── Stabilize / Compute Camera Drift ──
                dx, dy = 0, 0
                if not drift_calibrated and frame_counter > 15:
                    # Capture reference template (80x80 pixels in the middle)
                    ref_y, ref_x = ref_pos[1], ref_pos[0]
                    ref_template = cv2.cvtColor(frame[ref_y:ref_y+80, ref_x:ref_x+80], cv2.COLOR_BGR2GRAY)
                    drift_calibrated = True
                    print(f"  [STABILIZER] Referência de estabilização calibrada na posição {ref_pos}")
                elif drift_calibrated and ref_template is not None:
                    # Run template matching in a 120x120 search area around initial position
                    search_y, search_x = max(0, ref_pos[1]-20), max(0, ref_pos[0]-20)
                    search_area = cv2.cvtColor(frame[search_y:search_y+120, search_x:search_x+120], cv2.COLOR_BGR2GRAY)
                    
                    if search_area.shape[0] >= 80 and search_area.shape[1] >= 80:
                        res = cv2.matchTemplate(search_area, ref_template, cv2.TM_CCOEFF_NORMED)
                        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(res)
                        
                        if max_val > 0.65:
                            raw_dx = max_loc[0] - 20
                            raw_dy = max_loc[1] - 20
                            dx_smooth = 0.85 * dx_smooth + 0.15 * raw_dx
                            dy_smooth = 0.85 * dy_smooth + 0.15 * raw_dy
                            dx = int(round(dx_smooth))
                            dy = int(round(dy_smooth))
                
                # Update global drift variables for visual rendering
                global camera_drift_dx, camera_drift_dy
                camera_drift_dx = dx
                camera_drift_dy = dy

                # Apply visual feedback if drift occurs (for debugging)
                if abs(dx) > 1 or abs(dy) > 1:
                    cv2.putText(frame, f"DRIFT: dx={dx} dy={dy}", (10, 30), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

                infer_t0 = time.perf_counter()
                res_pose = model_pose.track(frame, imgsz=320, persist=True, verbose=False,
                                             conf=0.35, tracker="botsort.yaml")
                res_obj  = model_obj(frame, imgsz=320, verbose=False, conf=0.20)
                record_inference((time.perf_counter() - infer_t0) * 1000.0)

                active_pids = []
                person_heads = {}
                person_kpts = {}
                person_bboxes = {}
                wrist_positions = {}

                valid_products = []
                scene_class_set = set()
                receptacle_boxes = []

                # ── People ──
                if res_pose[0].boxes.id is not None:
                    ids  = res_pose[0].boxes.id.cpu().numpy().astype(int)
                    kpts = res_pose[0].keypoints.xy.cpu().numpy()
                    bxs  = res_pose[0].boxes.xyxy.cpu().numpy()

                    for i, pid in enumerate(ids):
                        feet = (int((bxs[i][0]+bxs[i][2])/2), int(bxs[i][3]))
                        head = (int((bxs[i][0]+bxs[i][2])/2), int(bxs[i][1]))
                        k = kpts[i]
                        wrists = [(int(k[9][0]), int(k[9][1])), (int(k[10][0]), int(k[10][1]))]
                        
                        armed = True
                        if active_zones:
                            # Shift the polygons by the calculated drift displacement
                            shifted_zones = []
                            for z in active_zones:
                                z_shifted = z + np.array([dx, dy], dtype=np.int32)
                                shifted_zones.append(z_shifted)
                                
                            armed = any(cv2.pointPolygonTest(z_shifted, feet, False) >= 0 or
                                        cv2.pointPolygonTest(z_shifted, head, False) >= 0 or
                                        cv2.pointPolygonTest(z_shifted, wrists[0], False) >= 0 or
                                        cv2.pointPolygonTest(z_shifted, wrists[1], False) >= 0
                                        for z_shifted in shifted_zones)
                        if not armed:
                            continue

                        active_pids.append(pid)
                        person_heads[pid] = head
                        person_bboxes[pid] = (int(bxs[i][0]), int(bxs[i][1]),
                                               int(bxs[i][2]), int(bxs[i][3]))
                        cx, cy = int((bxs[i][0]+bxs[i][2])/2), int((bxs[i][1]+bxs[i][3])/2)
                        person_kpts[pid] = {
                            'nose': (float(k[0][0]), float(k[0][1])),
                            'ls': (float(k[5][0]), float(k[5][1])),
                            'rs': (float(k[6][0]), float(k[6][1])),
                            'lw': (float(k[9][0]), float(k[9][1])),
                            'rw': (float(k[10][0]), float(k[10][1])),
                            'lh': (float(k[11][0]), float(k[11][1])),
                            'rh': (float(k[12][0]), float(k[12][1])),
                            'le': (float(k[7][0]), float(k[7][1])),
                            're': (float(k[8][0]), float(k[8][1])),
                            'center': (cx, cy),
                        }
                        wrist_positions[pid] = [(float(k[9][0]), float(k[9][1])),
                                                 (float(k[10][0]), float(k[10][1]))]

                # ── Objects ──
                if res_obj[0].boxes is not None and len(res_obj[0].boxes) > 0:
                    bxs_o = res_obj[0].boxes.xyxy.cpu().numpy()
                    clss  = res_obj[0].boxes.cls.cpu().numpy().astype(int)
                    confs = res_obj[0].boxes.conf.cpu().numpy()

                    for i in range(len(clss)):
                        cls = clss[i]
                        conf = float(confs[i])
                        x1, y1, x2, y2 = int(bxs_o[i][0]), int(bxs_o[i][1]), int(bxs_o[i][2]), int(bxs_o[i][3])
                        area = (x2-x1) * (y2-y1)

                        if cls == 0:
                            continue
                        if cls in BAG_CLASSES:
                            receptacle_boxes.append((x1, y1, x2, y2))
                            continue
                        if cls in BLOCKED_CLASSES:
                            continue
                        if cls not in PRODUCT_CLASSES:
                            continue
                        if area < MIN_OBJ_AREA or conf < MIN_OBJ_CONF:
                            continue

                        cx, cy = (x1+x2)//2, (y1+y2)//2
                        cls_name = PRODUCT_CLASSES[cls]
                        valid_products.append((cx, cy, cls, cls_name, x1, y1, x2, y2, conf))
                        scene_class_set.add(cls)

                metadata = {
                    'active_pids': active_pids,
                    'person_heads': person_heads,
                    'person_kpts': person_kpts,
                    'person_bboxes': person_bboxes,
                    'wrist_positions': wrist_positions,
                    'valid_products': valid_products,
                    'scene_class_set': scene_class_set,
                    'receptacle_boxes': receptacle_boxes,
                    'cam_ring_len': len(cam_ring)
                }

                self.loop.call_soon_threadsafe(self.queue_ref.put_nowait, (frame, metadata))
                time.sleep(0.005)

            except Exception as e:
                print(f"  [DETECT-AGENT ERRO] Loop de deteccao: {e}")
                time.sleep(0.1)


async def behavior_task():
    global latest_processed_frame, active_zones
    
    # Wait until engine and agent are fully initialized
    while engine is None or agent is None:
        await asyncio.sleep(0.1)

    recording_buffer = {}
    alert_timer = 0
    alert_text = ""
    last_sync = 0
    last_countdown_log = {}

    print("  [V6] [BEHAVIOR-AGENT] Agente de Comportamento Iniciado.")

    while True:
        try:
            now = time.time()
            if now - last_sync > 2.0:
                try:
                    db = await get_system_db()
                    async with db.execute("SELECT points_json FROM zones WHERE is_active = 1 AND camera_name = ?", (current_camera_name,)) as cur:
                        rows = await cur.fetchall()
                        active_zones = [
                            np.array([[round(p['x']), round(p['y'])]
                                      for p in json.loads(r[0])], np.int32).reshape((-1,1,2))
                            for r in rows]
                    await db.close()
                    last_sync = now
                except Exception as e:
                    pass

            # Evitar inflação da fila se houver gargalo temporário
            q_size = detection_queue.qsize()
            if q_size > 8:
                for _ in range(q_size - 2):
                    try:
                        detection_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break

            try:
                frame, metadata = await asyncio.wait_for(detection_queue.get(), timeout=0.1)
            except asyncio.TimeoutError:
                await asyncio.sleep(0.005)
                continue

            engine._current_frame = frame
            display = frame.copy()

            active_pids = metadata['active_pids']
            person_heads = metadata['person_heads']
            person_kpts = metadata['person_kpts']
            person_bboxes = metadata['person_bboxes']
            wrist_positions = metadata['wrist_positions']
            valid_products = metadata['valid_products']
            scene_class_set = metadata['scene_class_set']
            receptacle_boxes = metadata['receptacle_boxes']
            cam_ring_len = metadata['cam_ring_len']

            # Desenhar Bounding Boxes de Pessoas
            for pid in active_pids:
                trk = engine.persons.get(pid)
                col = trk.color if trk else (0,200,0)
                b = person_bboxes.get(pid)
                if b:
                    cv2.rectangle(display, (b[0],b[1]), (b[2],b[3]), col, 2)

            # Desenhar Bolsas/Mochilas
            for x1, y1, x2, y2 in receptacle_boxes:
                cv2.rectangle(display, (x1,y1), (x2,y2), (255,100,0), 2)
                cv2.putText(display, "BOLSA", (x1, y1-5), 0, 0.38, (255,100,0), 1)

            # Desenhar Objetos Detectados
            for px, py, cls, cls_name, x1, y1, x2, y2, conf in valid_products:
                cv2.rectangle(display, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(display, f"{cls_name} {conf:.0%}",
                            (x1, y1-6), 0, 0.35, (0, 255, 0), 1)

            # Processar lógica do motor comportamental
            engine_products = [(p[0], p[1], p[2], p[3]) for p in valid_products]
            alerts, new_recordings = engine.process(
                active_pids, person_kpts, person_bboxes,
                wrist_positions, engine_products, scene_class_set, receptacle_boxes,
                cam_ring_len=cam_ring_len)

            for pid in new_recordings:
                recording_buffer[pid] = True

            if alerts:
                for pid, score, report in alerts:
                    alert_timer = 150
                    alert_text = f"AGENTE analisando P_{pid}"
                    recording_buffer.pop(pid, None)

            for pid in list(recording_buffer.keys()):
                if pid not in engine.persons:
                    del recording_buffer[pid]

            # Desenhar HUD e Logs
            log_lines = list(engine.audit) + list(agent.audit)
            log_lines = log_lines[-14:]
            log_h = 28 + len(log_lines) * 15
            overlay = display.copy()
            cv2.rectangle(overlay, (0, 0), (500, log_h), (0,0,0), -1)
            cv2.addWeighted(overlay, 0.7, display, 0.3, 0, display)
            cv2.putText(display, "V6.7: AGENTES DESACOPLADOS + INTELIGENCIA POSE",
                        (6, 14), 0, 0.30, (100,200,255), 1)
            for i, line in enumerate(log_lines):
                c = (0,200,100)
                if 'ALERTA' in line or 'SUSPICIOUS' in line or 'SUSPEITO' in line: c = (0,0,255)
                elif 'DESAPARECEU' in line: c = (0,50,255)
                elif 'NÃO VISÍVEL' in line or 'ANALYZING' in line: c = (0,180,255)
                elif 'REAPARECEU' in line or 'CLEARED' in line: c = (0,255,100)
                elif 'Pegou' in line or 'TRACKING' in line: c = (0,255,255)
                elif 'SAIU' in line: c = (0,0,200)
                elif 'VLM' in line or 'AGENTE' in line: c = (255,200,100)
                elif 'olsa' in line: c = (255,165,0)
                cv2.putText(display, line, (6, 28+i*15), 0, 0.25, c, 1)

            # HUD por Pessoa
            for pid, head in person_heads.items():
                trk = engine.persons.get(pid)
                if not trk:
                    continue

                bw, bh = 80, 8
                bx, by = head[0]-bw//2, head[1]-42
                cv2.rectangle(display, (bx, by), (bx+bw, by+bh), (30,30,30), -1)
                fill = int(bw * min(1.0, trk.score))
                if fill > 0:
                    cv2.rectangle(display, (bx, by), (bx+fill, by+bh), trk.color, -1)
                cv2.rectangle(display, (bx, by), (bx+bw, by+bh), (100,100,100), 1)
                cv2.putText(display, f"{trk.alert_level} {trk.score:.0%}",
                            (bx, by-8), 0, 0.33, trk.color, 1)

                y_off = head[1] - 58
                for cls_id, prod in trk.products.items():
                    if prod.status == 'HELD':
                        txt = f"[{prod.cls_name}] na mão"
                        c = (0, 255, 255)
                    elif prod.status == 'MISSING':
                        elapsed = prod.missing_elapsed
                        remaining = max(0, GONE_TIMEOUT - elapsed)
                        txt = f"[{prod.cls_name}] SUMIU! {remaining:.0f}s"
                        c = (0, 100, 255)
                        key = f"{pid}_{cls_id}"
                        last_log = last_countdown_log.get(key, 0)
                        if now - last_log >= 5.0:
                            engine.log(f"P_{pid}: [{prod.cls_name}] sumiu há {elapsed:.0f}s ({remaining:.0f}s restantes)")
                            last_countdown_log[key] = now
                    elif prod.status == 'GONE':
                        txt = f"[{prod.cls_name}] DESAPARECIDO"
                        c = (0, 0, 255)
                    elif prod.status == 'BASKET':
                        txt = f"[{prod.cls_name}] CESTO"
                        c = (180, 180, 180)
                    else:
                        txt = f"[{prod.cls_name}] {prod.status}"
                        c = (150, 150, 150)
                    cv2.putText(display, txt, (head[0]-70, y_off), 0, 0.30, c, 1)
                    y_off -= 16

                if pid in recording_buffer:
                    cv2.circle(display, (head[0]+45, head[1]-35), 6, (0,0,255), -1)
                    cv2.putText(display, "REC", (head[0]+55, head[1]-30), 0, 0.28, (0,0,255), 1)

            # Flash de Alerta
            if alert_timer > 0:
                alert_timer -= 1
                t = max(4, int(18 * min(1.0, alert_timer/50.0)))
                cv2.rectangle(display, (0,0), (TARGET_W,TARGET_H), (0,0,255), t)
                cv2.putText(display, alert_text, (80,220), 0, 0.85, (255,255,255), 2)
                cv2.putText(display, "ENVIANDO CLIPE AO GEMINI...",
                            (100,252), 0, 0.45, (180,180,255), 1)

            global camera_drift_dx, camera_drift_dy
            for z in active_zones:
                z_shifted = z + np.array([camera_drift_dx, camera_drift_dy], dtype=np.int32)
                cv2.polylines(display, [z_shifted], True, (255,100,0), 2)

            stats = f"Produtos: {len(valid_products)} | Gravando: {len(recording_buffer)} | Bolsas: {len(receptacle_boxes)}"
            cv2.putText(display, stats, (TARGET_W-380, TARGET_H-10), 0, 0.30, (140,140,140), 1)

            latest_processed_frame = display
            await asyncio.sleep(0.005)

        except Exception as loop_err:
            import traceback
            print(f"  [ERRO BEHAVIOR TASK] {loop_err}")
            traceback.print_exc()
            await asyncio.sleep(1)


async def inference_task():
    global engine, agent, detection_queue, cam_fps
    
    # Initialize the queue
    detection_queue = asyncio.Queue()

    # Create local agent and loss prevention engine
    agent = LocalAgent(cam_ring, cam_ring_lock, lambda: cam_fps, engine_ref=lambda: engine)
    engine = LossPreventionEngine()
    engine.set_agent(agent)

    # Start local agent and behavior task inside the asyncio loop
    asyncio.create_task(agent.run())
    asyncio.create_task(behavior_task())

    # Start Detection Agent thread
    loop = asyncio.get_running_loop()
    detect_thread = DetectionAgentThread(loop, detection_queue)
    detect_thread.start()

    # Keep inference_task alive
    while True:
        await asyncio.sleep(3600)


# ═══════════════════════════════════════════════════════════════════
# Bootstrap
# ═══════════════════════════════════════════════════════════════════

async def fetch_rtsp_url():
    url = 0
    cam_name = 'camera_principal'
    try:
        db = await get_system_db()
        # Tenta a nova modelagem de multi-cameras primeiro
        try:
            async with db.execute("SELECT name, rtsp_url FROM cameras WHERE is_active = 1 ORDER BY id DESC LIMIT 1") as cur:
                row = await cur.fetchone()
                if row and row['rtsp_url']:
                    url = row['rtsp_url']
                    cam_name = row['name']
                    if isinstance(url, str) and url.isdigit():
                        url = int(url)
                    await db.close()
                    return url, cam_name
        except Exception as e:
            pass

        # Fallback para a configuracao antiga
        async with db.execute("SELECT value FROM config WHERE key = 'rtsp_url'") as cur:
            row = await cur.fetchone()
            if row and row['value']:
                url = row['value']
                if isinstance(url, str) and url.isdigit():
                    url = int(url)
        await db.close()
    except:
        pass
    return url, cam_name


current_camera_name = 'camera_principal'

async def main():
    global current_camera_name
    print("\n" + "="*60)
    print("  VISIONCAM LOSS PREVENTION V6.1")
    print("  YOLO26 (96% detection) + Scene Tracking + Gemini")
    print("  Pegou -> Acompanha na Cena -> Sumiu 20s -> Gemini")
    print("="*60)
    rtsp, current_camera_name = await fetch_rtsp_url()
    print(f"  [*] Stream: {rtsp} (Camera: {current_camera_name})")
    video_thread = VideoCaptureThread(rtsp)
    video_thread.start()

    async def monitor_rtsp():
        global current_camera_name
        nonlocal video_thread
        while True:
            await asyncio.sleep(5)
            try:
                new_rtsp, new_cam_name = await fetch_rtsp_url()
                if new_rtsp != video_thread.rtsp_url:
                    print(f"  [*] RTSP URL alterada. Reiniciando captura: {video_thread.rtsp_url} -> {new_rtsp}")
                    video_thread.running = False
                    await asyncio.sleep(1.5)
                    video_thread = VideoCaptureThread(new_rtsp)
                    video_thread.start()
                    current_camera_name = new_cam_name
            except Exception as e:
                print(f"  [CAM MONITOR] Erro ao verificar mudanca de camera: {e}")

    await asyncio.gather(inference_task(), stream_task(), monitor_rtsp())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"FATAL: {e}")
        import traceback; traceback.print_exc()
        input("Pressione Enter...")
