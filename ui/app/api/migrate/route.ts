import { NextResponse } from 'next/server';
import { query } from '../db';
import { autorizarMigracao } from '../migrations';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    // Esta rota altera o schema e reescreve papeis de usuario. Sem esta
    // verificacao ela era publica — ver ui/app/api/migrations.ts.
    const permissao = autorizarMigracao(request);
    if (!permissao.autorizado) {
      return NextResponse.json({ error: permissao.motivo }, { status: 401 });
    }

    await query(`
      CREATE TABLE IF NOT EXISTS appliances (
          id SERIAL PRIMARY KEY,
          store_id INTEGER REFERENCES stores(id),
          provisioning_code VARCHAR(20) UNIQUE,
          label VARCHAR(100),
          status VARCHAR(20) DEFAULT 'PENDING',
          target_version VARCHAR(50) DEFAULT 'latest',
          edge_key VARCHAR(100) UNIQUE,
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE events ADD COLUMN IF NOT EXISTS appliance_id INTEGER REFERENCES appliances(id);
      ALTER TABLE events ADD COLUMN IF NOT EXISTS human_feedback VARCHAR(50);
      
      ALTER TABLE hardware_status ADD COLUMN IF NOT EXISTS appliance_id INTEGER REFERENCES appliances(id);
    `);

    // ── Comandos remotos ────────────────────────────────────────────────────
    //
    // Fila de comandos do console para o appliance. O appliance vive atras do
    // NAT da loja: nao ha como abrir conexao ate ele, entao ele e quem puxa a
    // fila no mesmo loop que ja envia telemetria.
    //
    // Cada linha e uma ordem, nao um estado desejado. Guardar o historico —
    // em vez de sobrescrever um campo "ultimo comando" — e o que permite
    // responder "quem mandou reiniciar a loja 12 as 3h da manha?".
    await query(`
      CREATE TABLE IF NOT EXISTS appliance_commands (
          id            BIGSERIAL PRIMARY KEY,
          appliance_id  INTEGER NOT NULL REFERENCES appliances(id) ON DELETE CASCADE,
          comando       VARCHAR(50) NOT NULL,
          parametros    JSONB,
          -- PENDENTE -> ENTREGUE -> CONCLUIDO | FALHOU
          --          -> CANCELADO | EXPIRADO
          status        VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
          resultado     JSONB,
          issued_by     INTEGER,
          issued_email  VARCHAR(255),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          -- Um comando que ficou na fila enquanto a loja estava sem internet
          -- nao deve executar dois dias depois: o operador ja tomou outra
          -- decisao. Vence sozinho.
          expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
          delivered_at  TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ
      );

      -- A consulta quente e "o que esta pendente para este appliance", feita a
      -- cada poll de cada appliance da frota.
      CREATE INDEX IF NOT EXISTS idx_commands_fila
          ON appliance_commands(appliance_id, status, created_at);
    `);

    // RLS: a fila carrega dado de cliente (qual loja foi reiniciada, e quando),
    // entao segue a mesma regra das outras tabelas — ver
    // shared/schema_multitenant.sql. Sem politica, o papel visioncam_app
    // enxergaria a frota inteira.
    try {
      await query(`ALTER TABLE appliance_commands ENABLE ROW LEVEL SECURITY;`);
      await query(`DROP POLICY IF EXISTS command_isolamento ON appliance_commands;`);
      await query(`
        CREATE POLICY command_isolamento ON appliance_commands
            USING (app_is_super_admin() OR appliance_id IN (
                SELECT a.id FROM appliances a
                  JOIN stores s ON s.id = a.store_id
                 WHERE s.organization_id IN (SELECT app_orgs_permitidas())
            ));
      `);
    } catch (e) {
      // A politica depende das funcoes criadas por schema_multitenant.sql. Num
      // banco onde aquela migracao ainda nao rodou, falhar aqui derrubaria o
      // resto desta rota — e a tabela acima ja foi criada.
      console.error('[migrate] RLS de appliance_commands nao aplicada:', e);
    }

    try {
      await query(`ALTER TABLE hardware_status DROP CONSTRAINT IF EXISTS hardware_status_device_id_key;`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE hardware_status DROP CONSTRAINT IF EXISTS hardware_status_appliance_id_key;`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE hardware_status ADD CONSTRAINT hardware_status_appliance_id_key UNIQUE (appliance_id);`);
    } catch(e) {}

    return NextResponse.json({ success: true, message: "Migration applied successfully" });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
