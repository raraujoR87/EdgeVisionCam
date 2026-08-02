-- ============================================================================
-- VisionCam — Fundação multi-tenant
--
-- Migração aditiva e idempotente. Não destrói nada: cria a hierarquia que
-- falta, move os dados existentes para dentro dela e liga o isolamento no
-- banco. Pode rodar mais de uma vez.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTA MIGRAÇÃO RESOLVE
-- ---------------------------------------------------------------------------
--
-- 1. NÃO EXISTIA A ENTIDADE "CLIENTE".
--
--    `users.store_id` é um inteiro único: um usuário pertence a UMA loja. Uma
--    rede com 5 lojas precisaria de 5 contas separadas, e ninguém enxergaria o
--    conjunto. Isso trava no segundo cliente, não no milésimo.
--
--    A hierarquia correta tem três níveis, não dois:
--
--        organizations  (o cliente que assina)
--          └── stores        (as unidades físicas dele)
--                └── appliances
--          └── memberships   (quem acessa o quê, com qual papel)
--
--    `memberships` é uma tabela separada de propósito. Papel como coluna do
--    usuário significa um papel para a vida toda; como linha de associação,
--    a mesma pessoa pode ser STORE_ADMIN numa rede e VIEWER em outra — que é
--    o caso real de um gestor regional ou de uma franquia.
--
-- 2. O ISOLAMENTO VIVIA NO CÓDIGO DA APLICAÇÃO.
--
--    Cada rota precisava lembrar de filtrar por `store_id`. Um WHERE esquecido
--    não gera erro: devolve dados de outro cliente. Num SaaS isso é incidente
--    de dados, e é o tipo de defeito que passa em revisão porque a rota
--    "funciona".
--
--    Row Level Security inverte o modo de falha. Com RLS ativa, uma consulta
--    sem contexto de inquilino devolve ZERO linhas em vez de todas. Esquecer
--    passa a quebrar de forma visível, não silenciosa.
--
-- 3. NÃO HAVIA RASTRO DE QUEM FEZ O QUÊ.
--
--    Governança de SaaS exige responder "quem apagou esta loja?" e "quando
--    este usuário virou administrador?". `audit_log` registra isso.
--
-- ---------------------------------------------------------------------------
-- COMO A APLICAÇÃO PRECISA MUDAR
-- ---------------------------------------------------------------------------
--
-- RLS depende de a conexão saber quem está perguntando. O backend usa um pool
-- com credencial de serviço, então a identidade precisa ser declarada por
-- transação:
--
--     BEGIN;
--     SET LOCAL app.user_id = '42';
--     SET LOCAL app.is_super_admin = 'off';
--     SELECT * FROM events;        -- já vem filtrado pelo banco
--     COMMIT;
--
-- `SET LOCAL` é obrigatório: sem o LOCAL, o valor vaza para a próxima requisição
-- que reaproveitar a mesma conexão do pool — e aí um cliente veria os dados de
-- quem usou a conexão antes. Ver ui/app/api/tenant.ts.
-- ============================================================================


-- ── 1. Organizações (o inquilino) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) UNIQUE NOT NULL,
    -- Plano e limites moram no inquilino porque é ele que assina. Sem teto
    -- explícito, um cliente em trial pode provisionar appliances sem limite.
    plan            VARCHAR(50)  NOT NULL DEFAULT 'trial',
    max_stores      INTEGER      NOT NULL DEFAULT 1,
    max_appliances  INTEGER      NOT NULL DEFAULT 2,
    -- Suspender sem apagar: inadimplência não deve destruir dados do cliente.
    status          VARCHAR(20)  NOT NULL DEFAULT 'ativa',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_slug ON organizations(slug);


-- ── 2. Lojas passam a pertencer a uma organização ───────────────────────────

ALTER TABLE stores
    ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;

-- Cada loja órfã vira sua própria organização. Preserva o que existe sem exigir
-- decisão manual, e o SUPER_ADMIN reagrupa depois pelo painel.
INSERT INTO organizations (name, slug, plan, max_stores, max_appliances)
SELECT s.name,
       -- slug estável e único a partir do id, para não colidir com nomes iguais
       'org-' || s.id::text,
       'legado', 10, 20
FROM stores s
WHERE s.organization_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.slug = 'org-' || s.id::text);

UPDATE stores s
SET organization_id = o.id
FROM organizations o
WHERE s.organization_id IS NULL
  AND o.slug = 'org-' || s.id::text;

CREATE INDEX IF NOT EXISTS idx_stores_org ON stores(organization_id);


-- ── 3. Associações usuário ↔ organização ────────────────────────────────────

CREATE TABLE IF NOT EXISTS memberships (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role            VARCHAR(50) NOT NULL DEFAULT 'STORE_VIEWER',
    -- NULL = acesso a todas as lojas da organização. Preenchido = restrito a
    -- uma loja, que é o caso do fiscal contratado para uma unidade só.
    store_id        INTEGER REFERENCES stores(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, organization_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org  ON memberships(organization_id);

-- Converte o vínculo antigo (users.store_id + users.role) em associação.
-- users.store_id é mantida por ora: remover coluna em uso derruba a aplicação
-- no intervalo entre a migração e o deploy do código novo.
INSERT INTO memberships (user_id, organization_id, role, store_id)
SELECT u.id, s.organization_id, u.role, u.store_id
FROM users u
JOIN stores s ON s.id = u.store_id
WHERE u.store_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = u.id AND m.organization_id = s.organization_id
  );

-- SUPER_ADMIN não recebe associação: o acesso dele é global e vem do flag
-- abaixo, não de pertencer a alguma organização.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET is_super_admin = TRUE
WHERE role IN ('SUPER_ADMIN', 'admin') AND is_super_admin = FALSE;


-- ── 4. Trilha de auditoria ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- Guardado como texto porque o usuário pode ser removido depois, e a
    -- pergunta "quem fez isso?" continua tendo de ter resposta.
    actor_email     VARCHAR(255),
    action          VARCHAR(100) NOT NULL,
    resource_type   VARCHAR(50),
    resource_id     VARCHAR(100),
    detail          JSONB,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_org  ON audit_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);


-- ── 5. Isolamento no banco (RLS) ────────────────────────────────────────────
--
-- A partir daqui o banco recusa entregar dados de outro inquilino, mesmo que a
-- aplicação esqueça o filtro. As políticas leem duas variáveis de sessão que a
-- aplicação declara por transação.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS INTEGER AS $$
  -- NULLIF trata a variável não definida como NULL em vez de erro: uma conexão
  -- sem contexto simplesmente não enxerga nada, que é o comportamento desejado.
  SELECT NULLIF(current_setting('app.user_id', TRUE), '')::INTEGER;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS BOOLEAN AS $$
  SELECT COALESCE(current_setting('app.is_super_admin', TRUE) = 'on', FALSE);
$$ LANGUAGE SQL STABLE;

-- Organizações às quais o usuário corrente tem acesso.
CREATE OR REPLACE FUNCTION app_orgs_permitidas() RETURNS SETOF INTEGER AS $$
  SELECT organization_id FROM memberships WHERE user_id = app_user_id();
$$ LANGUAGE SQL STABLE;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appliances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolamento ON organizations;
CREATE POLICY org_isolamento ON organizations
    USING (app_is_super_admin() OR id IN (SELECT app_orgs_permitidas()));

DROP POLICY IF EXISTS store_isolamento ON stores;
CREATE POLICY store_isolamento ON stores
    USING (app_is_super_admin() OR organization_id IN (SELECT app_orgs_permitidas()));

DROP POLICY IF EXISTS appliance_isolamento ON appliances;
CREATE POLICY appliance_isolamento ON appliances
    USING (app_is_super_admin() OR store_id IN (
        SELECT id FROM stores WHERE organization_id IN (SELECT app_orgs_permitidas())
    ));

DROP POLICY IF EXISTS event_isolamento ON events;
CREATE POLICY event_isolamento ON events
    USING (app_is_super_admin() OR store_id IN (
        SELECT id FROM stores WHERE organization_id IN (SELECT app_orgs_permitidas())
    ));

DROP POLICY IF EXISTS audit_isolamento ON audit_log;
CREATE POLICY audit_isolamento ON audit_log
    USING (app_is_super_admin() OR organization_id IN (SELECT app_orgs_permitidas()));


-- ── 6. Ingestão vinda dos appliances ────────────────────────────────────────
--
-- Telemetria e eventos chegam autenticados por x-store-api-key, não por sessão
-- de usuário. Esse caminho não tem app.user_id e seria bloqueado pela RLS.
--
-- A saída NÃO é desligar a RLS: é dar ao processo de ingestão um papel próprio,
-- que pode inserir mas não ler transversalmente. Assim uma chave de appliance
-- vazada não vira leitura da base inteira.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'visioncam_ingest') THEN
        CREATE ROLE visioncam_ingest NOLOGIN;
    END IF;
END $$;

GRANT INSERT ON events, audit_log TO visioncam_ingest;
GRANT SELECT, INSERT, UPDATE ON hardware_status TO visioncam_ingest;
GRANT SELECT ON appliances, stores TO visioncam_ingest;

DROP POLICY IF EXISTS ingest_insere_evento ON events;
CREATE POLICY ingest_insere_evento ON events
    FOR INSERT TO visioncam_ingest WITH CHECK (TRUE);
