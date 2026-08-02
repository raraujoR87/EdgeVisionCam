import { NextResponse } from 'next/server';
import { query } from '../db';
import { verifyToken } from '../auth/tokens';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
    }
    const payload = verifyToken(authHeader.slice(7).trim());
    if (!payload) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const store_id = searchParams.get('store_id') || payload.store_id;

    if (!store_id && !['admin', 'SUPER_ADMIN'].includes(payload.role)) {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }

    // 1. Resumo Diário de Eventos (Últimos 7 dias)
    const dailyEventsRes = await query(`
      SELECT 
        DATE(analyzed_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN verdict = 'SUSPICIOUS' THEN 1 ELSE 0 END) as suspicious,
        SUM(CASE WHEN verdict = 'CLEAR' THEN 1 ELSE 0 END) as clear
      FROM events
      WHERE store_id = $1 AND analyzed_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(analyzed_at)
      ORDER BY DATE(analyzed_at) ASC
    `, [store_id]);

    // 2. Taxa de Falsos Positivos (Feedback Humano)
    const feedbackRes = await query(`
      SELECT 
        SUM(CASE WHEN human_feedback = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as true_positives,
        SUM(CASE WHEN human_feedback = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as false_positives,
        COUNT(*) as total_feedback
      FROM events
      WHERE store_id = $1 AND human_feedback IS NOT NULL
    `, [store_id]);

    // 3. Status da Frota
    const fleetRes = await query(`
      SELECT 
        COUNT(a.id) as total_appliances,
        SUM(CASE WHEN h.last_seen >= NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END) as online
      FROM appliances a
      LEFT JOIN hardware_status h ON a.id = h.appliance_id
      WHERE a.store_id = $1
    `, [store_id]);

    return NextResponse.json({
      daily: dailyEventsRes.rows,
      feedback: feedbackRes.rows[0],
      fleet: fleetRes.rows[0]
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
