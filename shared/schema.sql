-- ==============================================================================
-- Schema SQL do Centralizador de Gerência (VisionCam Cloud)
-- Compatível com Neon Postgres, Supabase e PostgreSQL padrão
-- ==============================================================================

-- 1. Tabela de Lojas / Clientes
CREATE TABLE IF NOT EXISTS stores (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    api_key VARCHAR(100) UNIQUE NOT NULL,
    portainer_endpoint VARCHAR(255),  -- Atalho para o Portainer Edge Agent
    telegram_bot_token VARCHAR(100),   -- Bot Telegram específico por loja
    telegram_chat_id VARCHAR(100),     -- Chat Telegram específico por loja
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabela de Eventos de Ocultação/Furtos Suspeitos
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    video_url VARCHAR(512),            -- Link do vídeo no Vercel Blob/S3
    telemetry JSONB,                  -- Dados biomecânicos e de telemetria
    suspicion_score NUMERIC(3,2),     -- Score biomecânico da borda
    verdict VARCHAR(50),              -- Veredicto do Gemini (ex: "SUSPICIOUS", "CLEAR", "EXCULPATORY")
    verdict_explanation TEXT,         -- Detalhes da auditoria multimodal
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabela de Telemetria e Status do Hardware (Radxa Boards)
CREATE TABLE IF NOT EXISTS hardware_status (
    store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
    cpu_usage NUMERIC(5,2),
    ram_usage NUMERIC(5,2),
    npu_status VARCHAR(50),           -- Ex: "ACTIVE_TIMVX", "CPU_FALLBACK"
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Inserir registros de semente (Seeds de teste)
INSERT INTO stores (name, location, api_key, portainer_endpoint, telegram_bot_token, telegram_chat_id)
VALUES 
('Supermercado Extra - Loja Centro', 'São Paulo - SP', 'vc_key_tok_loja_centro_001', 'https://portainer.visioncam.com.br/#/endpoints/1', '8522129486:AAGfNWwJXgtSmVk4Y-S33gJZJrqLHnExl18', '-1003776276819'),
('Supermercado Pão de Açúcar - Pinheiros', 'São Paulo - SP', 'vc_key_tok_pinheiros_002', 'https://portainer.visioncam.com.br/#/endpoints/2', '8522129486:AAGfNWwJXgtSmVk4Y-S33gJZJrqLHnExl18', '-1003776276819')
ON CONFLICT (api_key) DO NOTHING;
