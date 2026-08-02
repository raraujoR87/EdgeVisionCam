import { NextResponse } from 'next/server';
import { query } from '../db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    // 1. Add new columns to stores
    await query(`
      ALTER TABLE stores 
      ADD COLUMN IF NOT EXISTS operating_hours JSONB,
      ADD COLUMN IF NOT EXISTS business_rules TEXT,
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo';
    `);

    // 1.5. Add inference_ms to hardware_status (used by fleet health checks)
    await query(`
      ALTER TABLE hardware_status
      ADD COLUMN IF NOT EXISTS inference_ms NUMERIC(8,2);
    `);

    // 2. Change roles of existing users
    // If a user was 'admin', they become 'SUPER_ADMIN' if they have no store, else 'STORE_ADMIN'.
    // If a user was 'client', they become 'STORE_VIEWER'.
    await query(`
      UPDATE users SET role = 'SUPER_ADMIN' WHERE role = 'admin' AND store_id IS NULL;
    `);
    await query(`
      UPDATE users SET role = 'STORE_ADMIN' WHERE role = 'admin' AND store_id IS NOT NULL;
    `);
    await query(`
      UPDATE users SET role = 'STORE_VIEWER' WHERE role = 'client';
    `);

    // 3. Update the default role for new users
    await query(`
      ALTER TABLE users ALTER COLUMN role SET DEFAULT 'STORE_VIEWER';
    `);

    return NextResponse.json({ success: true, message: 'Migration applied successfully' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
