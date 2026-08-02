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
      \INSERT INTO stores (name, location, telegram_bot_token, telegram_chat_id, api_key)
       VALUES (\, \, \, \, \)
       RETURNING *\,
      [name, location || null, telegram_bot_token || null, telegram_chat_id || null, api_key]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
