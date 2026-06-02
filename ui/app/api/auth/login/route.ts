import { NextResponse } from 'next/server';
import { query } from '../../db';
import crypto from 'crypto';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    // Se for modo Local/Borda
    const isLocalOnly = process.env.NEXT_PUBLIC_LOCAL_ONLY === 'true';
    if (isLocalOnly) {
      if (!password) {
        return NextResponse.json({ error: 'Senha obrigatória' }, { status: 400 });
      }
      const hash = crypto.createHash('sha256').update(password).digest('hex');
      const expectedHash = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"; // sha256("admin")
      
      if (hash === expectedHash) {
        const tokenPayload = { email: 'admin@local', role: 'admin', store_id: null };
        const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
        return NextResponse.json({ status: 'success', token: `visioncam_tok_${token}` });
      } else {
        return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 });
      }
    }

    // Se for modo Nuvem (Supabase)
    if (!email || !password) {
      return NextResponse.json({ error: 'E-mail e senha são obrigatórios' }, { status: 400 });
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const userRes = await query('SELECT id, email, role, store_id, password_hash FROM users WHERE email = $1', [email]);
    
    if (userRes.rowCount === 0) {
      return NextResponse.json({ error: 'Usuário não cadastrado' }, { status: 401 });
    }

    const user = userRes.rows[0];
    if (user.password_hash === hash) {
      const tokenPayload = {
        id: user.id,
        email: user.email,
        role: user.role,
        store_id: user.store_id
      };
      const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
      return NextResponse.json({ status: 'success', token: `visioncam_tok_${token}` });
    } else {
      return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 });
    }
  } catch (error: any) {
    console.error('[Login API Error]', error);
    return NextResponse.json({ error: 'Erro interno no login', details: error.message }, { status: 500 });
  }
}
