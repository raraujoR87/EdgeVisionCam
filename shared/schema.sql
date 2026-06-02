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
    portainer_endpoint VARCHAR(255),  -- Regulagem do Portainer Edge Agent
    telegram_bot_token VARCHAR(100),   -- Bot Telegram específico por loja
    telegram_chat_id VARCHAR(100),     -- Chat Telegram específico por loja
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabela de Eventos de Ocultação/Furtos Suspeitos
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    video_url VARCHAR(512),            -- Link do vídeo no Cloudflare R2
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
-- Seeds de Inicialização
-- ==============================================================================

-- Inserir Lojas de Teste
INSERT INTO stores (id, name, location, api_key, portainer_endpoint, telegram_bot_token, telegram_chat_id)
VALUES 
(1, 'Supermercado Extra - Loja Centro', 'São Paulo - SP', 'vc_key_tok_loja_centro_001', 'https://portainer.visioncam.com.br/#/endpoints/1', '8522129486:AAGfNWwJXgtSmVk4Y-S33gJZJrqLHnExl18', '-1003776276819'),
(2, 'Supermercado Pão de Açúcar - Pinheiros', 'São Paulo - SP', 'vc_key_tok_pinheiros_002', 'https://portainer.visioncam.com.br/#/endpoints/2', '8522129486:AAGfNWwJXgtSmVk4Y-S33gJZJrqLHnExl18', '-1003776276819')
ON CONFLICT (api_key) DO NOTHING;

-- Inserir Usuários de Teste (Senha em texto puro comentada à direita)
-- Senhas: 
-- admin@visioncam.com.br -> admin
-- cliente1@extra.com.br -> client123
-- cliente2@pao.com.br -> client456
INSERT INTO users (email, password_hash, store_id, role)
VALUES
('admin@visioncam.com.br', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', NULL, 'admin'),
('cliente1@extra.com.br', '6106cf37d7a5b3a4a75abffc6f85eb3d7a868a8dc4e8c1cf07a4a9c680f4fcfc', 1, 'client'),
('cliente2@pao.com.br', '140e4f4fb38ee09bbff54d3dbe3a84eb83b48f936c53549646c075f850e04746', 2, 'client')
ON CONFLICT (email) DO NOTHING;
