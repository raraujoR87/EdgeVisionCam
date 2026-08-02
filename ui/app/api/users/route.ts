import { NextResponse } from 'next/server';
import { query } from '../db';
import { verifyToken } from '../auth/tokens';
import { gerarHash } from '../auth/passwords';

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

    if (payload.role === 'SUPER_ADMIN') {
      const res = await query('SELECT id, email, role, store_id, created_at FROM users ORDER BY id DESC');
      return NextResponse.json(res.rows);
    } else if (payload.role === 'STORE_ADMIN' && payload.store_id) {
      const res = await query('SELECT id, email, role, store_id, created_at FROM users WHERE store_id = $1 ORDER BY id DESC', [payload.store_id]);
      return NextResponse.json(res.rows);
    } else {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
    }
    const payload = verifyToken(authHeader.slice(7).trim());
    if (!payload || !['SUPER_ADMIN', 'STORE_ADMIN'].includes(payload.role)) {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }

    const { email, password, role, store_id } = await request.json();

    if (!email || !password || !role) {
      return NextResponse.json({ error: 'Campos obrigatórios' }, { status: 400 });
    }

    // Validação de RBAC na criação
    let targetStoreId = store_id;
    if (payload.role === 'STORE_ADMIN') {
      if (role === 'SUPER_ADMIN') {
        return NextResponse.json({ error: 'Não pode criar Super Admin' }, { status: 403 });
      }
      targetStoreId = payload.store_id; // Força a loja do admin
    }

    const passwordHash = gerarHash(password);

    const result = await query(
      `INSERT INTO users (email, password_hash, role, store_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role, store_id`,
      [email, passwordHash, role, targetStoreId || null]
    );

    return NextResponse.json(result.rows[0]);
  } catch (error: any) {
    if (error.message.includes('unique constraint')) {
      return NextResponse.json({ error: 'Email já cadastrado' }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
