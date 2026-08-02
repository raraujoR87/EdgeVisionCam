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
