import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from '../auth/tokens';
import { comInquilino, contextoDoToken } from '../tenant';
import { ehSuperAdmin, STORE_ADMIN } from '../papeis';

export const dynamic = 'force-dynamic';

/**
 * Leitura da trilha de auditoria.
 *
 * A trilha já era gravada, mas não havia como lê-la — governança que só escreve
 * é arquivo morto. Um cliente empresarial pergunta "quem apagou esta loja?" e a
 * resposta precisa estar a um clique, não num SELECT manual no Supabase.
 *
 * Somente leitura, de propósito: não há POST, PUT nem DELETE. Uma trilha que
 * pode ser alterada pela aplicação não serve como trilha — a primeira coisa que
 * alguém faria ao abusar do sistema seria apagar o próprio rastro.
 */

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;

function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice(7).trim());
  } catch {
    console.error('[audit] Não foi possível validar o token.');
    return null;
  }
}

export async function GET(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  // Só quem administra. Um OPERATOR ver quem convidou quem não ajuda em nada e
  // expõe a estrutura interna do cliente.
  if (!ehSuperAdmin(sessao.role) && sessao.role !== STORE_ADMIN) {
    return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const orgPedida = searchParams.get('organization_id');
  const acao = searchParams.get('action');

  // Teto no limite: sem ele, `?limit=999999` vira uma varredura que trava o
  // banco de todos os inquilinos.
  const limiteBruto = Number(searchParams.get('limit')) || LIMITE_PADRAO;
  const limite = Math.min(Math.max(limiteBruto, 1), LIMITE_MAXIMO);
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);

  try {
    const registros = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const condicoes: string[] = [];
      const params: any[] = [];

      if (orgPedida) {
        params.push(orgPedida);
        condicoes.push(`a.organization_id = $${params.length}`);
      }
      if (acao) {
        params.push(acao);
        condicoes.push(`a.action = $${params.length}`);
      }
      const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

      params.push(limite, offset);

      // A RLS de audit_log já limita às organizações do solicitante; os filtros
      // acima são recorte de exibição, não controle de acesso.
      const res = await cliente.query(
        `SELECT a.id, a.action, a.resource_type, a.resource_id,
                a.actor_email, a.detail, a.ip_address, a.created_at,
                o.name AS organization_name
           FROM audit_log a
           LEFT JOIN organizations o ON o.id = a.organization_id
           ${onde}
          ORDER BY a.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return res.rows;
    });

    return NextResponse.json({ registros, limite, offset });
  } catch (erro: any) {
    console.error('[audit GET]', erro);
    return NextResponse.json({ error: 'Falha ao ler a auditoria.' }, { status: 500 });
  }
}
