-- ==============================================================================
-- VMS Cloud — esquema do banco.
--
-- Premissa de produto: a nuvem NÃO armazena vídeo. Guarda o registro de cada
-- evento e o veredito da análise. O frame chega, é enviado ao modelo e é
-- descartado na memória do processo. Nenhuma coluna abaixo recebe imagem; um
-- teste de integração trava isso.
--
-- Isolamento: Row Level Security. A aplicação conecta com um papel de serviço
-- (que ignora RLS) e, em cada consulta de usuário, assume o papel `vms_app`
-- (que não ignora) com `SET LOCAL ROLE`. Ver lib/tenant.ts.
--
-- Idempotente: pode ser aplicado de novo sem perda de dados.
-- ==============================================================================

-- ── Tabelas ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'trial'
              CHECK (plan IN ('trial', 'essencial', 'profissional', 'enterprise')),
  status      TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuários são globais: uma mesma pessoa pode pertencer a mais de um cliente.
-- `is_platform_admin` é o papel do fornecedor (você). Não há papel global de
-- cliente — o papel vale por organização, em `memberships`.
CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT,                       -- NULL até o convite ser aceito
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERADOR', 'VISUALIZADOR')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

-- Convite com token de uso único. Guardamos só o hash do token: quem lê o banco
-- não consegue montar o link de ninguém.
CREATE TABLE IF NOT EXISTS invites (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERADOR', 'VISUALIZADOR')),
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address         TEXT,
  timezone        TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Câmera é criada pela primeira vez quando um agente envia um evento dela.
-- `external_ref` é o identificador que o agente usa localmente.
CREATE TABLE IF NOT EXISTS cameras (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  external_ref    TEXT NOT NULL,
  name            TEXT NOT NULL,
  last_event_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, external_ref)
);

-- Agente = o equipamento na loja que detecta e envia eventos. Autentica com uma
-- chave de alta entropia; no banco fica só o SHA-256, e o prefixo para exibição.
CREATE TABLE IF NOT EXISTS agents (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  last_seen_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um evento = uma detecção enviada por um agente, com o veredito da IA.
-- Sem coluna de imagem, de propósito.
CREATE TABLE IF NOT EXISTS events (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id             BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  camera_id           BIGINT REFERENCES cameras(id) ON DELETE SET NULL,
  agent_id            BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'PENDENTE'
                      CHECK (status IN ('PENDENTE', 'ANALISADO', 'FALHOU')),
  verdict             TEXT CHECK (verdict IN ('SUSPEITO', 'SEM_INDICIO', 'INCONCLUSIVO')),
  confidence          NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  summary             TEXT,
  labels              TEXT[] NOT NULL DEFAULT '{}',
  model               TEXT,
  error               TEXT,
  metadata            JSONB,
  analyzed_at         TIMESTAMPTZ,
  -- Revisão humana. É o dado que mede se o sistema acerta.
  human_verdict       TEXT CHECK (human_verdict IN ('PROCEDE', 'FALSO_ALARME')),
  reviewed_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_org_tempo ON events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_org_recebido ON events (organization_id, received_at);

-- Trilha de auditoria. Só cresce: a aplicação não tem UPDATE nem DELETE nela.
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_email     TEXT,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  detail          JSONB,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_tempo ON audit_log (organization_id, created_at DESC);

-- ── Papel da aplicação ────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vms_app') THEN
    CREATE ROLE vms_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ── Funções de contexto ───────────────────────────────────────────────
-- Leem a identidade declarada pela transação. Não recebem parâmetro do usuário.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::BIGINT
$$;

-- SECURITY DEFINER: consulta `users`/`memberships` sem passar pela própria RLS.
-- Sem isto, a política de `memberships` que consulta `memberships` recursaria.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND is_platform_admin)
$$;

CREATE OR REPLACE FUNCTION app_orgs_do_usuario() RETURNS SETOF BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT organization_id FROM memberships WHERE user_id = app_user_id()
$$;

CREATE OR REPLACE FUNCTION app_orgs_administradas() RETURNS SETOF BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT organization_id FROM memberships
   WHERE user_id = app_user_id() AND role = 'ADMIN'
$$;

CREATE OR REPLACE FUNCTION app_orgs_operadoras() RETURNS SETOF BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT organization_id FROM memberships
   WHERE user_id = app_user_id() AND role IN ('ADMIN', 'OPERADOR')
$$;

-- ── Row Level Security ────────────────────────────────────────────────

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras       ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;

-- organizations
DROP POLICY IF EXISTS org_leitura ON organizations;
CREATE POLICY org_leitura ON organizations FOR SELECT
  USING (id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin());
DROP POLICY IF EXISTS org_criacao ON organizations;
CREATE POLICY org_criacao ON organizations FOR INSERT
  WITH CHECK (app_is_platform_admin());
DROP POLICY IF EXISTS org_edicao ON organizations;
CREATE POLICY org_edicao ON organizations FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- users: enxerga quem divide organização com você. Só edita a própria linha.
DROP POLICY IF EXISTS usuario_leitura ON users;
CREATE POLICY usuario_leitura ON users FOR SELECT
  USING (
    id = app_user_id()
    OR app_is_platform_admin()
    OR id IN (SELECT m.user_id FROM memberships m
               WHERE m.organization_id IN (SELECT app_orgs_do_usuario()))
  );
DROP POLICY IF EXISTS usuario_edicao_propria ON users;
CREATE POLICY usuario_edicao_propria ON users FOR UPDATE
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- memberships: lê as da sua organização; altera só se for ADMIN dela.
DROP POLICY IF EXISTS vinculo_leitura ON memberships;
CREATE POLICY vinculo_leitura ON memberships FOR SELECT
  USING (
    user_id = app_user_id()
    OR organization_id IN (SELECT app_orgs_do_usuario())
    OR app_is_platform_admin()
  );
DROP POLICY IF EXISTS vinculo_escrita ON memberships;
CREATE POLICY vinculo_escrita ON memberships FOR ALL
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin())
  WITH CHECK (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());

DROP POLICY IF EXISTS convite_admin ON invites;
CREATE POLICY convite_admin ON invites FOR ALL
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin())
  WITH CHECK (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());

-- sites, cameras, agents: leitura para a organização; escrita para o ADMIN.
DROP POLICY IF EXISTS local_leitura ON sites;
CREATE POLICY local_leitura ON sites FOR SELECT
  USING (organization_id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin());
DROP POLICY IF EXISTS local_escrita ON sites;
CREATE POLICY local_escrita ON sites FOR ALL
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin())
  WITH CHECK (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());

DROP POLICY IF EXISTS camera_leitura ON cameras;
CREATE POLICY camera_leitura ON cameras FOR SELECT
  USING (organization_id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin());
DROP POLICY IF EXISTS camera_escrita ON cameras;
CREATE POLICY camera_escrita ON cameras FOR ALL
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin())
  WITH CHECK (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());

DROP POLICY IF EXISTS agente_leitura ON agents;
CREATE POLICY agente_leitura ON agents FOR SELECT
  USING (organization_id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin());
DROP POLICY IF EXISTS agente_escrita ON agents;
CREATE POLICY agente_escrita ON agents FOR ALL
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin())
  WITH CHECK (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());

-- events: leitura para qualquer membro. Escrita de análise não passa por aqui
-- (é o caminho do agente, ver lib/ingestao.ts). A revisão humana passa, e o
-- privilégio de coluna abaixo limita o que ela pode alterar.
DROP POLICY IF EXISTS evento_leitura ON events;
CREATE POLICY evento_leitura ON events FOR SELECT
  USING (organization_id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin());
DROP POLICY IF EXISTS evento_revisao ON events;
CREATE POLICY evento_revisao ON events FOR UPDATE
  USING (organization_id IN (SELECT app_orgs_operadoras()))
  WITH CHECK (
    organization_id IN (SELECT app_orgs_operadoras())
    AND reviewed_by = app_user_id()
  );

-- audit_log: ADMIN da organização e fornecedor leem. Qualquer membro grava
-- entradas em seu próprio nome.
DROP POLICY IF EXISTS audit_leitura ON audit_log;
CREATE POLICY audit_leitura ON audit_log FOR SELECT
  USING (organization_id IN (SELECT app_orgs_administradas()) OR app_is_platform_admin());
DROP POLICY IF EXISTS audit_gravacao ON audit_log;
CREATE POLICY audit_gravacao ON audit_log FOR INSERT
  WITH CHECK (
    (organization_id IN (SELECT app_orgs_do_usuario()) OR app_is_platform_admin())
    AND actor_user_id = app_user_id()
  );

-- ── Privilégios ───────────────────────────────────────────────────────
-- Concedidos tabela a tabela. Um GRANT amplo em `public` deixaria tabelas
-- futuras acessíveis sem que ninguém decidisse isso.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vms_app;
GRANT USAGE ON SCHEMA public TO vms_app;
GRANT EXECUTE ON FUNCTION app_user_id(), app_is_platform_admin(),
  app_orgs_do_usuario(), app_orgs_administradas(), app_orgs_operadoras() TO vms_app;

GRANT SELECT, INSERT, UPDATE ON organizations TO vms_app;
GRANT SELECT, UPDATE         ON users         TO vms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invites, sites, cameras, agents TO vms_app;

-- events: a revisão só altera três colunas. O veredito da IA não é alterável
-- por nenhum papel de usuário.
GRANT SELECT ON events TO vms_app;
GRANT UPDATE (human_verdict, reviewed_by, reviewed_at) ON events TO vms_app;

-- audit_log: sem UPDATE e sem DELETE.
GRANT SELECT, INSERT ON audit_log TO vms_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vms_app;

-- Conexão de serviço (a DATABASE_URL) precisa poder assumir o papel.
DO $$
BEGIN
  EXECUTE format('GRANT vms_app TO %I', current_user);
END
$$;
