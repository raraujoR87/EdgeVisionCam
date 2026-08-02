import { NextResponse } from 'next/server';
import { query } from '../db';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await query('SELECT * FROM stores ORDER BY id ASC');
    return NextResponse.json(res.rows);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, location, telegram_bot_token, telegram_chat_id } = body;

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { id, name, location, telegram_bot_token, telegram_chat_id, operating_hours, business_rules, timezone } = body;

    if (!id) {
      return NextResponse.json({ error: 'Store ID is required' }, { status: 400 });
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
      return NextResponse.json({ error: 'Store not found' }, { status: 404 });
    }

    return NextResponse.json(result.rows[0]);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
