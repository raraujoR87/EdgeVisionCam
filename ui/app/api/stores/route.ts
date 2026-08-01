import { NextResponse } from 'next/server';
import { query, isDatabaseNotConfigured } from '../db';
import { verifyToken } from '../auth/tokens';

/**
 * Lista as lojas — usada pelos seletores do console.
 *
 * Não devolve `api_key` nem os tokens do Telegram: a tela precisa de nome e id
 * para montar um seletor, e a chave da loja só sai por /api/provisioning/claim,
 * mediante código de uso único.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Token ausente' }, { status: 401 });
    }

    const payload = verifyToken(header.slice(7).trim());
    if (!payload) {
      return NextResponse.json({ error: 'Token inválido ou expirado' }, { status: 401 });
    }

    // Cliente enxerga apenas a própria loja; administrador enxerga todas.
    const res = payload.role === 'admin'
      ? await query('SELECT id, name, location FROM stores ORDER BY name ASC')
      : await query('SELECT id, name, location FROM stores WHERE id = $1', [payload.store_id]);

    return NextResponse.json({ stores: res.rows });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Stores API Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
