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
    role VARCHAR(50) DEFAULT 'client', -- 'admin' ou 'client'
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
