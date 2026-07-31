import { NextResponse } from 'next/server';
import { query, isDatabaseNotConfigured } from '../../db';
import crypto from 'crypto';
import { signToken } from '../tokens';

/**
 * Login do modo nuvem.
 *
 * O modo local nao passa por aqui: o navegador fala direto com a API do
 * appliance (ver getApiUrl em app/utils/api.ts), que valida a senha contra o
 * hash gravado no system.db. O ramo local que existia nesta rota carregava um
 * hash de "admin" fixo no fonte e emitia um token sem assinatura, entao era um
 * segundo caminho de autenticacao — mais fraco — para o mesmo sistema.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: 'E-mail e senha são obrigatórios' }, { status: 400 });
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const userRes = await query(
      'SELECT id, email, role, store_id, password_hash FROM users WHERE email = $1',
      [email]
    );

    // Mesma mensagem para usuario inexistente e senha errada: enumerar contas
    // validas a partir da resposta nao deve ser possivel.
    if (userRes.rowCount === 0) {
      return NextResponse.json({ error: 'Credenciais inválidas' }, { status: 401 });
    }

    const user = userRes.rows[0];
    const stored = Buffer.from(user.password_hash || '', 'utf-8');
    const provided = Buffer.from(hash, 'utf-8');
    const matches =
      stored.length === provided.length && crypto.timingSafeEqual(stored, provided);

    if (!matches) {
      return NextResponse.json({ error: 'Credenciais inválidas' }, { status: 401 });
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      role: user.role,
      store_id: user.store_id,
    });

    return NextResponse.json({ status: 'success', token });
  } catch (error: any) {
    console.error('[Login API Error]', error);

    // Falha de configuração não é falha de credencial. Dizer "senha incorreta"
    // aqui manda o operador procurar defeito no lugar errado.
    if (isDatabaseNotConfigured(error)) {
      return NextResponse.json(
        { error: 'Banco de dados não configurado no servidor (DATABASE_URL ausente).' },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: 'Erro interno no login' }, { status: 500 });
  }
}
