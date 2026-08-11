-- ==============================================================================
-- Schema SQL do Centralizador de Gerência (VisionCam Cloud)
-- Compatível com Neon Postgres, Supabase e PostgreSQL padrão
-- ==============================================================================

-- 1. Tabela de Lojas / Clientes
CREATE TABLE IF NOT EXISTS stores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    api_key VARCHAR(100) UNIQUE NOT NULL, -- API Key legada (para compatibilidade)
    portainer_endpoint VARCHAR(255),  -- Regulagem do Portainer Edge Agent
    telegram_bot_token VARCHAR(100),   -- Bot Telegram específico por loja
    telegram_chat_id VARCHAR(100),     -- Chat Telegram específico por loja
    operating_hours JSONB,             -- Horários de funcionamento ex: {"open":"08:00","close":"22:00"}
    business_rules TEXT,               -- Regras de negócio / contexto para o Gemini
    timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 1.5 Tabela de Dispositivos / Câmeras (Appliances)
CREATE TABLE IF NOT EXISTS appliances (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    provisioning_code VARCHAR(10) UNIQUE,
    label VARCHAR(255),
    target_version VARCHAR(50),
    edge_key VARCHAR(100) UNIQUE,
    status VARCHAR(50) DEFAULT 'PENDENTE',
    expires_at TIMESTAMP WITH TIME ZONE,
    claimed_at TIMESTAMP WITH TIME ZONE,
    claimed_ip VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 1.6 Fila de comandos remotos (console -> appliance)
--
-- O appliance vive atrás do NAT da loja: não há rota da nuvem até ele, então o
-- console enfileira aqui e o appliance puxa no mesmo loop em que já manda
-- telemetria. Ver ui/app/api/edge/commands/route.ts.
--
-- Cada linha é uma ordem, não um estado desejado. Guardar o histórico — em vez
-- de sobrescrever um campo "último comando" — é o que permite responder "quem
-- mandou reiniciar a loja 12 às 3h da manhã?".
CREATE TABLE IF NOT EXISTS appliance_commands (
    id BIGSERIAL PRIMARY KEY,
    appliance_id INTEGER NOT NULL REFERENCES appliances(id) ON DELETE CASCADE,
    comando VARCHAR(50) NOT NULL,
    parametros JSONB,
    -- PENDENTE -> ENTREGUE -> CONCLUIDO | FALHOU | SEM_RESPOSTA
    --          -> CANCELADO | EXPIRADO
    status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    resultado JSONB,
    issued_by INTEGER,
    issued_email VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Um comando enfileirado enquanto a loja estava sem internet não deve
    -- executar dois dias depois: o operador já tomou outra decisão.
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
    delivered_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- A consulta quente é "o que está pendente para este appliance", feita a cada
-- poll de cada appliance da frota.
CREATE INDEX IF NOT EXISTS idx_commands_fila
    ON appliance_commands(appliance_id, status, created_at);

-- 2. Tabela de Eventos de Ocultação/Furtos Suspeitos
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    appliance_id INTEGER REFERENCES appliances(id) ON DELETE CASCADE, -- Novo
    video_url VARCHAR(512),            -- Link do vídeo no Cloudflare R2
    telemetry JSONB,                  -- Dados biomecânicos e de telemetria
    suspicion_score NUMERIC(3,2),     -- Score biomecânico da borda
    verdict VARCHAR(50),              -- Veredicto do Gemini (ex: "SUSPICIOUS", "CLEAR", "EXCULPATORY")
    verdict_explanation TEXT,         -- Detalhes da auditoria multimodal
    human_feedback VARCHAR(50),       -- Loop de Feedback: "TRUE_POSITIVE", "FALSE_POSITIVE", NULL
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabela de Telemetria e Status do Hardware (Radxa Boards)
CREATE TABLE IF NOT EXISTS hardware_status (
    appliance_id INTEGER PRIMARY KEY REFERENCES appliances(id) ON DELETE CASCADE,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    cpu_usage NUMERIC(5,2),
    ram_usage NUMERIC(5,2),
    npu_status VARCHAR(50),           -- Ex: "ACTIVE_TIMVX", "CPU_FALLBACK"
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Tabela de Usuários para Área do Cliente
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL, -- Hash SHA256 da senha do usuário
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, -- NULL para administradores globais
    role VARCHAR(50) DEFAULT 'STORE_VIEWER', -- 'SUPER_ADMIN', 'STORE_ADMIN', 'STORE_OPERATOR', 'STORE_VIEWER'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- Provisionamento
-- ==============================================================================
--
-- Este arquivo cria apenas a estrutura. Nenhum dado real de loja, credencial ou
-- usuario e versionado aqui.
--
-- A versao anterior trazia seeds com um token de bot do Telegram e o chat ID do
-- grupo de alertas em texto puro. Como o repositorio e publico, esses valores
-- ficaram expostos e precisaram ser revogados — segredo em arquivo versionado
-- deve ser tratado como comprometido a partir do primeiro push.
--
-- Para provisionar uma instalacao, use npm run seed (ui/scripts/seed.mjs), que
-- le os valores do ambiente e gera a senha inicial do administrador.
--
-- Se preferir fazer manualmente, o molde e este — substituindo os valores:
--
--   INSERT INTO stores (name, location, api_key, telegram_bot_token, telegram_chat_id)
--   VALUES ('<nome da loja>', '<cidade>', '<chave gerada>', '<token>', '<chat id>');
--
--   INSERT INTO users (email, password_hash, store_id, role)
--   VALUES ('<email>', '<sha256 da senha>', NULL, 'admin');
--
-- ==============================================================================
