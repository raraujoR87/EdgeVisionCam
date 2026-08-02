import { NextResponse } from 'next/server';
import { query } from '../db';
import crypto from 'crypto';
import { gerarCodigo } from '../provisioning/codigo';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const store_id = searchParams.get('store_id');
    
    let res;
    if (store_id) {
      res = await query('SELECT * FROM appliances WHERE store_id = $1 ORDER BY id ASC', [store_id]);
    } else {
      res = await query('SELECT * FROM appliances ORDER BY id ASC');
    }
    
    return NextResponse.json(res.rows);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { store_id, label, target_version } = body;

    if (!store_id) {
      return NextResponse.json({ error: 'store_id is required' }, { status: 400 });
    }

    const edge_key = crypto.randomUUID();
    const provisioning_code = gerarCodigo();

    const result = await query(
      `INSERT INTO appliances (store_id, label, target_version, edge_key, provisioning_code, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [store_id, label || 'Novo Dispositivo', target_version || 'latest', edge_key, provisioning_code]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
