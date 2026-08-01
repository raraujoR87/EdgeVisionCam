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
- **Visão Computacional:** OpenCV + YOLO26 (Ultralytics) — modelos `yolo26n-pose` (pose) e `yolo26s` (objetos).
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

## 6. Modelo de Segurança

O appliance possui **dois planos de autenticação independentes**, que nunca se
substituem:

| Plano | Quem usa | Mecanismo |
|---|---|---|
| **Sessão** | Operador via Dashboard | Token HMAC-SHA256 com validade de 12h, emitido por `/api/auth/login` |
| **Interno** | Engine → API (`/api/internal/*`) | Segredo compartilhado no header `X-Internal-Token` |

**Regras invioláveis:**
- Senhas usam **PBKDF2-HMAC-SHA256 com salt por senha** (260k iterações). Hashes
  SHA-256 de instalações antigas continuam válidos e migram sozinhos no primeiro
  login bem-sucedido.
- Os segredos de assinatura são **gerados na primeira execução** e gravados em
  `system.db`. Nenhuma instalação compartilha chave com outra, e nenhum digest
  fica fixo no código-fonte.
- `/api/config` **nunca** devolve valores de segredo — apenas indicadores
  `<chave>_is_set`. A lista está em `CONFIG_SECRET_KEYS`.
- `/video_feed` aceita o token via query string porque a tag `<img>` do
  dashboard não envia headers. **É o único endpoint com essa permissão** —
  token em URL vaza para log de acesso e histórico do navegador.
- `POST /api/config` só grava chaves da lista `CONFIG_WRITABLE_KEYS`. Sem essa
  restrição, um POST bastaria para sobrescrever a chave que assina os tokens.

### Troca obrigatória da senha de fábrica
A senha inicial é `admin` — pública, portanto equivalente a não ter senha.
Enquanto `password_is_default` estiver `true`:

- `/api/auth/login` responde com `must_change_password: true`;
- `/api/auth/verify` continua respondendo 200, para que a UI distinga
  *token inválido* de *precisa trocar a senha*;
- **todo o resto da API responde 403.** Nenhuma câmera, zona ou evento fica
  acessível.

O bloqueio vive em `verify_token`, no servidor — a tela `/change-password` é a
face dele, não o mecanismo. Chamar a API diretamente não pula a etapa.

### Modo nuvem (Vercel)
Exige a variável de ambiente **`AUTH_SECRET`** (mínimo 32 caracteres). Sem ela a
aplicação recusa autenticar — falha fechada por projeto, para que nenhum deploy
rode com uma chave padrão previsível. Veja `ui/.env.example`.

```bash
# gere um valor distinto por ambiente
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

---

## 7. Testes

```bash
pip install -r requirements-dev.txt
pytest
```

A suíte cobre as primitivas de autenticação, a superfície de autorização da API
e o canal de métricas de inferência. Cada teste de segurança corresponde a um
vetor concreto que já esteve aberto, então eles funcionam como trava de
regressão — não como cobertura decorativa.

---

## 8. Estado Atual do Deployment
O sistema está operando em modo **Res-Sync (640x480)**, garantindo que as zonas desenhadas no Dashboard correspondam perfeitamente à visão da IA. A sincronia entre a UI e a Engine ocorre em intervalos de 3 segundos sem necessidade de reiniciar os serviços.

A inferência roda a **320x320, limitada a 5 FPS** (`inference_interval = 0.200`).
Esse teto não é arbitrário: um ciclo completo (pose + objetos) mede
**~120-145 ms em CPU**, valor agora reportado de verdade em
`telemetry.inference_ms`. É a margem que justifica a aceleração NPU.

### Aceleração NPU — estado real
`edge/vivante_pose_engine.py` deixou de ser um esqueleto. O que está pronto e
testado:

- **Decodificador de saída** para os dois layouts YOLO-pose, escolhido pelo
  formato do tensor: end-to-end `(N, 57)` do YOLO26 (NMS no grafo) e por
  âncoras `(56, A)` do YOLOv8 (NMS na CPU). O layout foi verificado contra a
  saída real do `yolo26n-pose.onnx`.
- **Letterbox e volta ao espaço do frame.** Sem isso as caixas saem
  distorcidas e não correspondem às zonas de guarda do dashboard.
- **`track()`**, que não existia. `vision_engine` chama `model_pose.track(...)`
  e lê `boxes.id` — com um `.nbg` configurado, a engine quebrava no warmup com
  `AttributeError` antes de qualquer inferência.
- **Rastreador por IoU** para gerar as identidades que o BoT-SORT fornece no
  caminho de CPU.

O que **não** foi validado, por depender do hardware: a execução no silício
Vivante e o efeito da quantização INT8 sobre a precisão. O caminho completo foi
exercitado com um grafo simulado que roda o ONNX real do mesmo modelo, e as
caixas resultantes batem com a referência do ultralytics dentro de ~8px numa
imagem de 1080px.

**Modelo escolhido para a NPU: `yolov8n-pose`.** A saída por âncoras usa apenas
operadores que o compilador Acuity suporta com segurança; o YOLO26 embute o NMS
no grafo, e compiladores de NPU costumam rejeitar esses operadores. O decoder
suporta os dois, então trocar depois é mudar uma variável — mas começar pelo
YOLOv8 evita descobrir uma incompatibilidade só no `pegasus import`.

Paridade medida contra o ultralytics na mesma imagem, com o ONNX real:

| Modelo | Saída | IoU por caixa |
|---|---|---|
| `yolov8n-pose` | `(1, 56, 2100)` âncoras | 0.995 / 0.999 / 0.937 |
| `yolo26n-pose` | `(1, 300, 57)` end-to-end | 0.997 / 0.988 / 0.910 |

O resíduo vem do letterbox: o ultralytics usa retângulo alinhado ao stride
(320x256), enquanto a NPU exige tensor de entrada quadrado de tamanho fixo.
Não é erro de decodificação.

### Pipeline de compilação
```bash
python3 npu_compilation/export_onnx.py            # 1. modelo → ONNX
python3 npu_compilation/prepare_calibration.py    # 2. dataset de calibração
bash    npu_compilation/compilar_nbg.sh           # 3. ONNX → NBG (Docker ACUITY)
export POSE_MODEL_PATH=edge/yolov8n-pose.nbg      # 4. aponta a engine
```

O passo 2 captura frames **da própria câmera da loja**, caindo para clipes de
evento gravados e só então para imagens genéricas do COCO. Isso importa: a
quantização INT8 dimensiona as escalas a partir dessas imagens, e calibrar com
cenas que não parecem com a loja derruba a precisão no dispositivo — não no
teste. O script avisa quando cai no COCO.

### Operação offline
Os pesos YOLO são baixados **durante o build da imagem**, não em runtime. Um
appliance sem acesso à internet sobe normalmente. Ao alterar
`POSE_MODEL_PATH`/`OBJ_MODEL_PATH`, atualize também a etapa de download no
`Dockerfile` — caso contrário a engine volta a depender da rede no primeiro
frame.
