import { NextResponse } from 'next/server';
import { query, isDatabaseNotConfigured } from '../../db';
import { signToken } from '../tokens';
import { conferirSenha, ehHashLegado, gerarHash } from '../passwords';

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
    if (!conferirSenha(password, user.password_hash || '')) {
      return NextResponse.json({ error: 'Credenciais inválidas' }, { status: 401 });
    }

    // Login válido com hash antigo: reescreve em PBKDF2 sem incomodar o
    // usuário. Mesma migração transparente que o appliance faz.
    if (ehHashLegado(user.password_hash)) {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        gerarHash(password),
        user.id,
      ]);
      console.log(`[Auth] Hash de ${user.email} migrado para PBKDF2.`);
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
