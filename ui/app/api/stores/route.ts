import { NextResponse } from 'next/server';
import { query } from '../db';
import { verifyToken, TokenPayload } from '../auth/tokens';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/** Extrai e valida o token. Retorna null se inválido. */
function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return verifyToken(header.slice(7).trim());
}

/** Roles que têm poder de administrador global. */
function isAdmin(role: string): boolean {
  return ['admin', 'SUPER_ADMIN'].includes(role);
}

/**
 * GET /api/stores
 * - SUPER_ADMIN: vê todas as lojas
 * - STORE_ADMIN: vê apenas a sua loja
 */
export async function GET(request: Request) {
  try {
    const user = extrairSessao(request);
    if (!user) {
      return NextResponse.json({ error: 'Token ausente ou inválido.' }, { status: 401 });
    }

    if (isAdmin(user.role)) {
      // Admin global: todas as lojas com contagem de appliances e eventos
      const res = await query(`
        SELECT s.*,
               COALESCE((SELECT COUNT(*) FROM appliances a WHERE a.store_id = s.id), 0)::integer AS appliance_count,
               COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id), 0)::integer AS event_count
        FROM stores s
        ORDER BY s.id ASC
      `);
      return NextResponse.json(res.rows);
    }

    if (['STORE_ADMIN', 'STORE_OPERATOR', 'STORE_VIEWER'].includes(user.role) && user.store_id) {
      const res = await query('SELECT * FROM stores WHERE id = $1', [user.store_id]);
      return NextResponse.json(res.rows);
    }

    return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 });
  } catch (error: any) {
    console.error('[Stores GET]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/stores
 * Apenas SUPER_ADMIN pode criar lojas.
 */
export async function POST(request: Request) {
  try {
    const user = extrairSessao(request);
    if (!user || !isAdmin(user.role)) {
      return NextResponse.json({ error: 'Apenas administradores podem criar lojas.' }, { status: 403 });
    }

    const body = await request.json();
    const { name, location, telegram_bot_token, telegram_chat_id } = body;

    if (!name) {
      return NextResponse.json({ error: 'Nome da loja é obrigatório.' }, { status: 400 });
    }

    const api_key = crypto.randomUUID();

    const result = await query(
      `INSERT INTO stores (name, location, telegram_bot_token, telegram_chat_id, api_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, location || null, telegram_bot_token || null, telegram_chat_id || null, api_key]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error: any) {
    console.error('[Stores POST]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/stores
 * SUPER_ADMIN edita qualquer loja; STORE_ADMIN edita apenas a sua.
 */
export async function PUT(request: Request) {
  try {
    const user = extrairSessao(request);
    if (!user) {
      return NextResponse.json({ error: 'Token ausente ou inválido.' }, { status: 401 });
    }

    const body = await request.json();
    const { id, name, location, telegram_bot_token, telegram_chat_id, operating_hours, business_rules, timezone } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID da loja é obrigatório.' }, { status: 400 });
    }

    // STORE_ADMIN só edita a própria loja
    if (!isAdmin(user.role)) {
      if (user.role !== 'STORE_ADMIN' || Number(user.store_id) !== Number(id)) {
        return NextResponse.json({ error: 'Sem permissão para editar esta loja.' }, { status: 403 });
      }
    }

    const result = await query(
      `UPDATE stores 
       SET name = COALESCE($1, name),
           location = COALESCE($2, location),
           telegram_bot_token = COALESCE($3, telegram_bot_token),
           telegram_chat_id = COALESCE($4, telegram_chat_id),
           operating_hours = COALESCE($5, operating_hours),
           business_rules = COALESCE($6, business_rules),
           timezone = COALESCE($7, timezone)
       WHERE id = $8
       RETURNING *`,
      [name, location, telegram_bot_token, telegram_chat_id, operating_hours ? JSON.stringify(operating_hours) : null, business_rules, timezone, id]
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Loja não encontrada.' }, { status: 404 });
    }

    return NextResponse.json(result.rows[0]);
  } catch (error: any) {
    console.error('[Stores PUT]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/stores?id=X
 * Apenas SUPER_ADMIN. Exclui a loja e todos os dados vinculados (cascade).
 */
export async function DELETE(request: Request) {
  try {
    const user = extrairSessao(request);
    if (!user || !isAdmin(user.role)) {
      return NextResponse.json({ error: 'Apenas administradores podem excluir lojas.' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'ID da loja é obrigatório.' }, { status: 400 });
    }

    const result = await query('DELETE FROM stores WHERE id = $1 RETURNING id, name', [id]);
    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Loja não encontrada.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, deleted: result.rows[0] });
  } catch (error: any) {
    console.error('[Stores DELETE]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
