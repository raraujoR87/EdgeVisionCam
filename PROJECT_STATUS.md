# 📑 VisionCam: Edge-Safe AI - Project Blueprint

## 1. Visão Geral da Arquitetura (Edge-Safe AI)
O projeto é um appliance de segurança autônomo projetado para rodar integralmente na borda (Edge), utilizando IA para detectar furtos e ocultação de produtos sem dependência de nuvem para a lógica primária.

**Paradigma:** Local-First Vision Intelligence.

---

## 2. Stack Tecnológica (The Omega Stack)
- **Ambiente:** Bare-metal Host (Windows/Linux).
- **Backend:** Python 3.11+ (FastAPI).
- **Frontend:** React/Next.js (App Router, TailwindCSS, Glassmorphism).
- **Banco de Dados:** SQLite Assíncrono (`aiosqlite`) - SSOT (Single Source of Truth).
- **Visão Computacional:** OpenCV + YOLOv8 (Ultralytics).
- **Cérebro Cognitivo:** LangGraph (StateGraph) + Gemini 1.5 Flash (via novo SDK `google-genai`).

---

## 3. Fluxo de Dados (The Z-Flow)
1. **Percepção (Edge):** `vision_engine.py` captura vídeo, redimensiona para 640x480 e executa modelos de **Pose** e **Objetos** simultaneamente.
2. **Filtragem Espacial:** O sistema sincroniza zonas de guarda (Guard Zones) em tempo real do banco de dados. A IA ignora qualquer atividade fora destas zonas.
3. **Máquina de Estados Biomecânica:** 
   - **Posse:** O pulso intercepta um produto (box amarelo).
   - **Ancoragem:** O sistema "trava" o objeto na mão detectada.
   - **Ocultação:** Se a mão entrar no polígono do tronco e o objeto sumir por > 8 frames, o gatilho dispara.
4. **Persistência de Evento:** Um clipe de 15s (H.264) é gerado e registrado no `queue.db` como `PENDING`.
5. **Orquestração Cognitiva:** O `agent.py` detecta o evento, faz o upload para o Gemini 1.5 Flash e recebe um veredito estruturado (JSON).
6. **Interface SOC:** O Dashboard exibe o veredito, estatísticas por zona e permite gerenciar perímetros.

---

## 4. Módulos Implementados
- [x] **`/shared/schemas.py`**: Contratos Pydantic únicos.
- [x] **`/core/database/db.py`**: Gestor SQLite com migrações automáticas.
- [x] **`/core/api_internal/main.py`**: API Gateway, MJPEG Streamer e Telemetria.
- [x] **`/core/graph/agent.py`**: Orquestrador LangGraph com novo SDK Gemini.
- [x] **`/edge/vision_engine.py`**: Motor de visão desacoplado com sincronia de zona instantânea.
- [x] **`/ui`**: Dashboard completo (Overview, Setup, Audit, Settings).

---

## 5. Diretrizes Visuais de Segurança
- **ZERO TEXTO:** Frames exportados não contêm labels textuais, apenas geometria pura (boxes e esqueletos).
- **Feedback Neon:** 
  - **Cinza:** Fora de zona.
  - **Azul/Verde:** Dentro de zona ativa.
  - **Vermelho (Borda):** Evento de ocultação em curso.

---

## 6. Estado Atual do Deployment
O sistema está operando em modo **Res-Sync (640x480)**, garantindo que as zonas desenhadas no Dashboard correspondam perfeitamente à visão da IA. A sincronia entre a UI e a Engine ocorre em intervalos de 3 segundos sem necessidade de reiniciar os serviços.
