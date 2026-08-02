# VisionCam — Arquitetura

Documento de referência único. Define **onde cada coisa roda**, **quem fala com
quem**, e **qual é o contrato** entre as partes. Se algo neste documento
divergir do código, o código está errado ou o documento está desatualizado —
nos dois casos é um defeito a corrigir, não uma ambiguidade a tolerar.

---

## 1. As duas metades

O sistema é composto por dois produtos que se comunicam por HTTPS, e **cada um
funciona sem o outro**:

| | Appliance (borda) | Console (nuvem) |
|---|---|---|
| Onde roda | Radxa Cubie A7A, dentro da loja | Vercel + Postgres (Supabase) |
| Responsabilidade | Ver, decidir, agir | Consolidar, analisar, administrar |
| Se o outro cair | Continua detectando e alertando | Continua servindo dados já recebidos |
| Latência aceitável | Milissegundos | Segundos |

**A decisão de furto é sempre local.** A nuvem nunca está no caminho crítico de
uma detecção. Isso não é otimização: a rede de uma loja cai, e um antifurto que
dependa dela para decidir é um antifurto que não funciona quando mais importa.

---

## 2. O que roda na Radxa

```
câmera IP ──RTSP──> Frigate ──MQTT──> visioncam-core
                       │                    │
                       │                    ├── vision_engine   (YOLO pose + objetos)
                       │                    ├── local_agent     (máquina de estados)
                       │                    └── api_internal    (FastAPI :8000)
                       │                              │
                    clipes                       SQLite local
                                                      │
                                              visioncam-ui (:3000)
                                              console do técnico
```

### Componentes

| Serviço | Porta | Papel |
|---|---|---|
| `frigate` | 5000, 8554 | NVR: captura RTSP, detecção de movimento, gravação de clipes |
| `mqtt` | 127.0.0.1:1883 | Barramento de eventos entre Frigate e o núcleo |
| `visioncam-core` | 8000, 8090 | Inferência, decisão, API local |
| `visioncam-ui` | 3000 | Console local do técnico (instalação, zonas, diagnóstico) |
| `docker-socket-proxy` | — | Acesso restrito ao Docker, para logs e restart |

O MQTT fica preso ao loopback de propósito: roda sem autenticação, e exposto na
rede da loja permitiria publicar eventos de detecção forjados.

### Inferência

Roda a 320×320, limitada a 5 FPS. Em CPU, um ciclo completo (pose + objetos)
leva **120–145 ms**. É a margem que justifica a NPU.

A NPU VeriSilicon VIP9000 (3 TOPS) está operacional — driver, runtime e silício
verificados. Falta o modelo compilado. Ver [`npu_compilation/README.md`](npu_compilation/README.md).

### Estado local

SQLite em volume Docker (`db_data`). Guarda câmeras, zonas de guarda, eventos,
configuração e a fila de sincronização com a nuvem.

---

## 3. O que roda na nuvem

```
                     ┌──────────────────────────────┐
   appliances ──────>│  /api/telemetry   (x-store-api-key)
   (N lojas)  ──────>│  /api/webhook     (x-store-api-key)
                     │  /api/provisioning/claim  (código)
                     └──────────────┬───────────────┘
                                    │
                              Postgres (Supabase)
                                    │
                     ┌──────────────┴───────────────┐
   navegador ───────>│  /dashboard/*     (Bearer token)
                     │  /api/stores, /users, /provisioning, /analytics
                     └──────────────────────────────┘
```

### Modelo de dados

```
stores ──┬── appliances ──── hardware_status
         ├── users
         └── events
```

Uma loja (`store`) é o **inquilino**. Todo dado pertence a exatamente uma loja.
Um appliance pertence a uma loja; uma loja pode ter vários appliances.

### Papéis (RBAC)

| Papel | Escopo | Pode |
|---|---|---|
| `SUPER_ADMIN` | Global | Tudo: criar lojas, emitir códigos, ver todas as lojas |
| `STORE_ADMIN` | Sua loja | Convidar equipe, editar a loja, ver relatórios |
| `STORE_OPERATOR` | Sua loja | Monitorar em tempo real, dar feedback nos alertas |
| `STORE_VIEWER` | Sua loja | Somente leitura de painéis |

> **Dívida conhecida:** existe o papel legado `'admin'`, tratado como equivalente
> a `SUPER_ADMIN` em `isAdmin()`. É uma ponte de migração, não um design. Ver §7.

---

## 4. Os contratos entre borda e nuvem

Esta é a fronteira. **Três canais, três formas de autenticação distintas** — e a
distinção é proposital: um appliance não tem sessão de usuário, e um usuário não
deve poder se passar por appliance.

### 4.1 Provisionamento — nuvem → appliance (uma vez)

O técnico digita um código de 8 caracteres no console local. O appliance o
resgata e recebe sua identidade.

```
POST /api/provisioning/claim
     { "codigo": "ACDE-FGHJ" }
  →  { "status": "success",
       "store":  { "id", "name", "api_key" },
       "deploy": { "version", "edge_key", "mgmt_mode" } }
```

- **Credencial:** o próprio código. Uso único, expira em 7 dias.
- **Por que assim:** nenhuma credencial permanente é digitada em campo. O
  técnico não precisa ter — nem poder vazar — a chave da loja.
- Alfabeto sem caracteres ambíguos (`0/O`, `1/I`, `8/B`), compartilhado entre
  `edge_provisioning.py` e `ui/app/api/provisioning/codigo.ts`. Divergir faz a
  placa recusar códigos legítimos, e isso só apareceria na loja.

### 4.2 Telemetria — appliance → nuvem (periódico)

```
POST /api/telemetry
     x-store-api-key: <edge_key ou api_key da loja>
     { "cpu_usage", "ram_usage", "npu_status", "inference_ms" }
```

- **Credencial:** `edge_key` do appliance. Aceita a `api_key` da loja como
  fallback legado, criando o appliance automaticamente.
- `npu_status` é `ACTIVE_VIPLITE` ou `CPU_FALLBACK`.
- `inference_ms` é a latência medida de verdade. É por ela que o painel
  distingue "online" de "online e detectando".

### 4.3 Eventos — appliance → nuvem (por ocorrência)

```
POST /api/webhook
     x-store-api-key: <chave>
     { evento, classificação, clipe, metadados }
```

- **Credencial:** a mesma da telemetria.
- O appliance enfileira localmente e reenvia. Perda de rede não perde evento.

### O que a nuvem **não** faz

- Não decide se algo é furto.
- Não recebe vídeo contínuo — só clipes de evento.
- Não comanda o appliance em tempo real. A gerência remota de containers, quando
  usada, é do Portainer Edge Agent, que disca para fora (§6).

---

## 5. Fluxos de ponta a ponta

### Instalar uma loja nova

```
 1. SUPER_ADMIN cria a loja no console                  /dashboard/stores
 2. SUPER_ADMIN emite um código de provisionamento      /dashboard/deploys
 3. Técnico liga a Radxa na rede da loja
 4. Técnico abre http://visioncam.local:8080
 5. Técnico digita o código e clica em instalar
 6. O appliance resgata a configuração, baixa as imagens e sobe
 7. Técnico cadastra a câmera e desenha as zonas de guarda   :3000
 8. O appliance começa a enviar telemetria e eventos
```

O passo 6 é automático. O appliance chega à loja com o instalador subindo no
boot e respondendo por mDNS — nenhum SSH é necessário em campo.

### Uma detecção

```
frame → YOLO pose+objetos → máquina de estados local
                              IDLE → TRACKING → ANALYZING → SUSPICIOUS
                                                     │
                                        ┌────────────┴────────────┐
                                   alerta local              POST /api/webhook
                                   (Telegram)                (consolidação)
```

A decisão e o alerta são locais. O envio à nuvem é assíncrono e reenviável.

---

## 6. Operação

| Tarefa | Onde | Comando |
|---|---|---|
| Diagnóstico do appliance | Radxa | `bash deploy/diagnostico.sh` |
| Diagnóstico da NPU | Radxa | `bash deploy/npu_diagnostico.sh` |
| Instalar runtime da NPU | Radxa | `bash deploy/instalar_npu_sdk.sh` |
| Atualizar em produção | Radxa | `bash deploy/atualizar.sh` |
| Reverter atualização | Radxa | `bash deploy/reverter.sh` |
| Compilar modelo p/ NPU | PC x86 | `bash npu_compilation/compilar_nbg.sh` |
| Migrar schema da nuvem | Console | `GET /api/migrate-rbac` (autenticado) |

`atualizar.sh` constrói na própria placa, marca as imagens para rollback e
reverte sozinho se a stack nova não responder. O appliance roda em produção; uma
atualização que quebre deixa a loja sem detecção até alguém voltar lá.

---

## 7. Dívida técnica conhecida

Registrada aqui para não virar surpresa. Ordenada por impacto.

| # | O quê | Impacto | Onde |
|---|---|---|---|
| 1 | Quantização INT8 zera a confiança do detector | NPU inutilizável até resolver | [`npu_compilation/README.md`](npu_compilation/README.md) §Quantização |
| 2 | Acurácia nunca foi medida com dados rotulados | Não se sabe a taxa de falso alarme real | `evaluation/` |
| 3 | Papel legado `'admin'` convive com `SUPER_ADMIN` | Confusão e risco de divergência entre checagens | `isAdmin()` em várias rotas |
| 4 | `edge/viplite.py` não executou o caminho completo no silício | Binding correto contra os headers, não validado ponta a ponta | `edge/viplite.py` |
| 5 | LGPD: falta base legal documentada, DPIA e contrato de operador | Bloqueia venda para cliente com jurídico | [`PRIVACIDADE.md`](PRIVACIDADE.md) |

### Sobre o item 1

É o bloqueio ativo. A saída do YOLOv8-pose concatena coordenadas (0–320) e
confiança (0–1) num tensor só. A quantização por tensor usa uma escala única —
medida em **1,57** nesta placa — e a confiança passa a representar apenas `0` ou
`1,57`. Tudo abaixo de 0,785 vira zero.

Compensar no decodificador já foi tentado e produziu falsos positivos em quadros
vazios. A informação se perdeu na quantização; nenhum pós-processamento a
recupera. O caminho é `QUANT=int16` ou separar as saídas no ONNX.

---

## 8. Segurança — decisões e porquês

| Decisão | Motivo |
|---|---|
| `AUTH_SECRET` obrigatória, mínimo 32 caracteres | Sem ela a aplicação recusa autenticar. Falha fechada, para que nenhum deploy rode com chave previsível |
| Tokens com HMAC-SHA256 e expiração | A versão anterior confiava no payload sem assinatura: qualquer um forjava um token de admin |
| PBKDF2-HMAC-SHA256, 260k iterações | Migração transparente dos hashes SHA-256 legados no primeiro login |
| Sistema bloqueado até trocar a senha de fábrica | Enquanto `admin` estiver em uso, toda a API responde 403 |
| MQTT preso ao loopback | Roda sem autenticação; exposto, aceitaria eventos forjados da rede da loja |
| Socket Docker atrás de proxy restrito | Quem fala com o socket cria container privilegiado com o disco do host |
| `MIGRATION_SECRET` para as rotas de migração | Elas alteram schema e reescrevem papéis; eram públicas |
| Segredos nunca retornam pela API | Os campos aparecem vazios mesmo quando configurados; salvar em branco mantém o valor |

---

## 9. Onde encontrar cada coisa

```
edge/            engine de visão, agente cognitivo, binding da NPU
core/            API interna do appliance, banco local, segurança
ui/              Next.js — serve tanto o console local quanto a nuvem
                 (NEXT_PUBLIC_LOCAL_ONLY distingue os dois modos)
deploy/          scripts de campo: diagnóstico, instalação, upgrade, rollback
npu_compilation/ pipeline ONNX → NBG e coleta de calibração
evaluation/      medição de acurácia (precisão, revocação, falso alarme)
shared/          schema SQL e utilitários compartilhados
tests/           251 testes
```

**Documentos:**
[`DEPLOY.md`](DEPLOY.md) · [`npu_compilation/README.md`](npu_compilation/README.md) ·
[`PRIVACIDADE.md`](PRIVACIDADE.md) · [`PROJECT_STATUS.md`](PROJECT_STATUS.md) ·
[`portainer/README.md`](portainer/README.md)
