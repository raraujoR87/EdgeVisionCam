# Guia de Deploy — VisionCam

Duas metades independentes, que podem ser implantadas em qualquer ordem:

| | Onde roda | O que faz |
|---|---|---|
| **Console de nuvem** | Vercel + Postgres | Painel analítico multi-loja, auditoria global |
| **Appliance de borda** | Radxa Cubie A7A | Captura, inferência, detecção e clipes |

O appliance funciona sem a nuvem — a lógica primária é local. A nuvem consolida
telemetria e eventos de várias lojas.

---

## Parte 1 — Console de nuvem (Vercel)

### 1.1 Banco de dados

Qualquer Postgres serve (Supabase, Neon, RDS). Guarde a connection string.

### 1.2 Provisionamento

```bash
cd ui
npm install

DATABASE_URL='postgres://...' \
ADMIN_EMAIL='voce@empresa.com' \
STORE_NAME='Loja Centro' \
npm run seed
```

O script cria as tabelas e o administrador global. **Anote a senha e a API key
impressas — elas não são exibidas de novo.** A API key vai para o appliance
como `store_api_key`.

> Os seeds com credenciais que existiam em `shared/schema.sql` foram removidos.
> O arquivo hoje só cria estrutura.

### 1.3 Variáveis de ambiente na Vercel

| Variável | Obrigatória | Valor |
|---|---|---|
| `AUTH_SECRET` | **Sim** | Mínimo 32 caracteres. Gere com o comando abaixo |
| `DATABASE_URL` | **Sim** | Connection string do Postgres |
| `NEXT_PUBLIC_LOCAL_ONLY` | Sim | `false` |

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

`AUTH_SECRET` assina os tokens de sessão. **Sem ela a aplicação recusa
autenticar** — falha fechada de propósito, para que nenhum deploy rode com uma
chave padrão previsível. Gere um valor distinto por ambiente (produção,
preview), e não reaproveite entre projetos.

### 1.4 Deploy

O diretório raiz do projeto na Vercel é **`ui`**, não a raiz do repositório.

```bash
cd ui && vercel --prod
```

Ou conecte o repositório pelo painel, definindo *Root Directory* = `ui`.

### 1.5 Verificação

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://SEU-APP.vercel.app/login          # 200
curl -s https://SEU-APP.vercel.app/api/auth/verify -H 'Authorization: Bearer falso' # 401
```

Um **500** em `/api/auth/verify` significa `AUTH_SECRET` ausente ou com menos de
32 caracteres.

---

## Parte 2 — Appliance de borda (Radxa)

### 2.1 Construir as imagens

O Radxa é **ARM64**. Uma build feita em x86 sem `buildx` gera imagens que a
placa recusa com `exec format error`.

```bash
./scripts/build_and_push.sh v1.0.0
```

Publica `visioncam-core` e `visioncam-ui` para `linux/amd64` e `linux/arm64`.
Para construir só o necessário à placa (bem mais rápido):

```bash
PLATFORMS=linux/arm64 ./scripts/build_and_push.sh v1.0.0
```

### 2.2 Instalar na placa

```bash
ssh radxa@IP-DA-PLACA
curl -fsSL https://raw.githubusercontent.com/raraujoR87/EdgeVisionCam/main/install.sh -o install.sh
sudo bash install.sh
```

O `install.sh` instala Docker, clona o repositório e sobe a stack: Frigate,
MQTT, Portainer agent, core e UI.

### 2.3 Primeiro acesso

Abra `http://IP-DA-PLACA:3000`.

A senha inicial é `admin` — **e o sistema fica bloqueado até você trocá-la.**
Enquanto a senha de fábrica estiver em uso, toda a API responde 403: câmera,
zona, evento e stream ficam inacessíveis. O login leva direto à tela de troca.

Depois disso, em *Zone Setup*:
1. Cadastre a câmera (URL RTSP).
2. Desenhe as zonas de guarda sobre o preview.

### 2.4 Conectar à nuvem (opcional)

Em *Engine Room → Vault Credentials*:

| Campo | Valor |
|---|---|
| `store_api_key` | A API key impressa pelo `npm run seed` |
| `cloud_api_url` | `https://SEU-APP.vercel.app` |
| `model_source` | `cloud` para enviar telemetria |

Os campos de segredo aparecem vazios mesmo quando configurados — a API nunca
devolve o valor, só se ele existe. Deixar em branco ao salvar **mantém** o
segredo atual; digitar substitui.

### 2.5 Aceleração NPU (opcional)

Por padrão a inferência roda em CPU (~120–145 ms por ciclo), com throttle de
5 FPS. Para usar a NPU Vivante:

```bash
python3 npu_compilation/export_onnx.py            # modelo → ONNX
python3 npu_compilation/prepare_calibration.py    # calibração (usa a câmera da loja)
bash    npu_compilation/acuity_export_yolo.sh     # ONNX → NBG (Docker Acuity, x86)
```

Copie o `.nbg` para `edge/` na placa e aponte a engine:

```yaml
# docker-compose.yml, serviço visioncam-core
environment:
  - POSE_MODEL_PATH=edge/yolov8n-pose.nbg
```

A telemetria passa a reportar `ACTIVE_TIMVX` no lugar de `CPU_FALLBACK`.
Rode o passo de calibração **com a câmera da loja conectada** — a quantização
INT8 dimensiona as escalas a partir dessas imagens, e calibrar com cenas
genéricas derruba a precisão no dispositivo sem aparecer em teste algum.

---

## Operação

```bash
docker compose ps                        # estado dos serviços
docker compose logs -f visioncam-core    # logs da engine
docker compose pull && docker compose up -d   # atualizar
python3 reset_system.py                  # limpar eventos e zonas
```

### Diagnóstico

| Sintoma | Causa provável |
|---|---|
| `exec format error` | Imagem construída para a arquitetura errada — ver 2.1 |
| Tudo responde 403 | Senha de fábrica ainda em uso — troque-a |
| 500 no login da nuvem | `AUTH_SECRET` ausente ou curta demais |
| `CPU_FALLBACK` na telemetria | SDK `timvx` ausente ou `.nbg` não encontrado |
| Preview sem imagem | Frigate fora do ar; o MJPEG da engine é o fallback |
| `inference_ms` em 0.0 | Nenhuma inferência rodou ainda — engine parada |

---

## Segurança — regras que não podem ser quebradas

- **Nunca versione segredos.** O repositório é público. Um token commitado deve
  ser tratado como comprometido a partir do primeiro push — o histórico do git
  o preserva mesmo depois de removido do arquivo. Revogue e gere outro.
- `AUTH_SECRET` distinta por ambiente, nunca reaproveitada.
- Trocar a senha de fábrica antes de colocar o appliance em operação (o sistema
  obriga).
- O appliance expõe as portas 3000, 8000 e 5000. Mantenha-o em VLAN isolada ou
  atrás de firewall — não exponha diretamente à internet.
