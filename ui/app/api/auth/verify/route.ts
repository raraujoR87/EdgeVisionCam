import { NextResponse } from 'next/server';
import { query } from '../../db';

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    if (!token.startsWith('visioncam_tok_')) {
      return NextResponse.json({ error: 'Token com formato incorreto' }, { status: 401 });
    }

    const base64Payload = token.replace('visioncam_tok_', '');
    const decodedStr = Buffer.from(base64Payload, 'base64').toString('utf-8');
    const payload = JSON.parse(decodedStr);

    // Se for modo local
    if (process.env.NEXT_PUBLIC_LOCAL_ONLY === 'true') {
      if (payload.email === 'admin@local') {
        return NextResponse.json({ status: 'valid', user: payload });
      }
      return NextResponse.json({ error: 'Sessão local inválida' }, { status: 401 });
    }

    // Se for modo nuvem, validar existência do usuário no Supabase
    const userRes = await query('SELECT id, email, role, store_id FROM users WHERE email = $1', [payload.email]);
    if (userRes.rowCount === 0) {
      return NextResponse.json({ error: 'Usuário não existe mais no sistema' }, { status: 401 });
    }

    return NextResponse.json({ status: 'valid', user: userRes.rows[0] });
  } catch (error: any) {
    return NextResponse.json({ error: 'Token inválido', details: error.message }, { status: 401 });
  }
}
