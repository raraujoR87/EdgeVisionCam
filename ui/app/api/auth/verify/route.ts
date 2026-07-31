import { NextResponse } from 'next/server';
import { query } from '../../db';
import { verifyToken } from '../tokens';

/**
 * Verificacao de sessao do modo nuvem.
 *
 * A assinatura do token e conferida antes de qualquer coisa. A versao anterior
 * decodificava o base64 e confiava no `email` que viesse dentro, o que permitia
 * forjar uma sessao de administrador sem nenhum segredo.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
    }

    const payload = verifyToken(authHeader.slice(7).trim());
    if (!payload) {
      return NextResponse.json({ error: 'Token inválido ou expirado' }, { status: 401 });
    }

    // A assinatura prova quem emitiu; a consulta confirma que a conta ainda
    // existe, cobrindo usuarios removidos com token ainda dentro da validade.
    const userRes = await query(
      'SELECT id, email, role, store_id FROM users WHERE email = $1',
      [payload.email]
    );
    if (userRes.rowCount === 0) {
      return NextResponse.json({ error: 'Usuário não existe mais no sistema' }, { status: 401 });
    }

    return NextResponse.json({ status: 'valid', user: userRes.rows[0] });
  } catch (error: any) {
    console.error('[Verify API Error]', error);
    return NextResponse.json({ error: 'Token inválido' }, { status: 401 });
  }
}
