import { NextResponse } from 'next/server';
import { query } from '../db';

export const maxDuration = 15; // Configuração Vercel nativa para tempo limite


export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get('x-store-api-key') || '';
    if (!apiKey) {
      return NextResponse.json({ error: 'Faltando cabeçalho x-store-api-key' }, { status: 401 });
    }

    const body = await request.json();
    const { cpu_usage, ram_usage, npu_status } = body;
    // Opcional: appliances em versão anterior não enviam este campo.
    const inference_ms = body.inference_ms ?? null;

    if (cpu_usage === undefined || ram_usage === undefined || !npu_status) {
      return NextResponse.json({ error: 'Campos obrigatórios ausentes: cpu_usage, ram_usage, npu_status' }, { status: 400 });
    }

    // 1. Validar a loja pela API Key
    const storeRes = await query('SELECT id, name FROM stores WHERE api_key = $1', [apiKey]);
    if (storeRes.rowCount === 0) {
      return NextResponse.json({ error: 'Chave de API inválida' }, { status: 401 });
    }

    const storeId = storeRes.rows[0].id;

    // 2. Inserir ou Atualizar o status do hardware
    await query(`
      INSERT INTO hardware_status (store_id, cpu_usage, ram_usage, npu_status, inference_ms, last_seen)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (store_id)
      DO UPDATE SET
        cpu_usage = EXCLUDED.cpu_usage,
        ram_usage = EXCLUDED.ram_usage,
        npu_status = EXCLUDED.npu_status,
        inference_ms = EXCLUDED.inference_ms,
        last_seen = CURRENT_TIMESTAMP
    `, [storeId, cpu_usage, ram_usage, npu_status, inference_ms]);

    return NextResponse.json({ success: true, store: storeRes.rows[0].name });
  } catch (error: any) {
    console.error('[Telemetry API Error]', error);
    return NextResponse.json({ error: 'Erro interno do servidor', details: error.message }, { status: 500 });
  }
}
