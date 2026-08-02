import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifyToken, TokenPayload } from '../auth/tokens';
import {
  comInquilino,
  contextoDoToken,
  registrarAuditoria,
  ipDaRequisicao,
  dentroDoLimite,
} from '../tenant';
import { ehSuperAdmin, STORE_ADMIN } from '../papeis';

export const dynamic = 'force-dynamic';

/**
 * CRUD de lojas.
 *
 * Esta rota filtrava por `store_id` em cada consulta. Funcionava, mas o modo de
 * falha era péssimo: um WHERE esquecido não gera erro — entrega dados de outro
 * cliente, e passa em revisão porque a rota responde certo nos testes felizes.
 *
 * Agora todo acesso passa por `comInquilino()`, que declara a identidade na
 * transação e deixa a Row Level Security do Postgres decidir. As consultas
 * abaixo não têm cláusula de inquilino nenhuma — de propósito. Sem contexto
 * declarado elas devolvem zero linhas, em vez de tudo.
 */

function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice(7).trim());
  } catch {
    // verifyToken lança quando AUTH_SECRET está ausente — erro de configuração,
    // não credencial inválida. Devolver null aqui vira 401, que é o certo para
    // o cliente; o log abaixo é o que aponta a causa real ao operador.
    console.error('[stores] Não foi possível validar o token.');
    return null;
  }
}



function semSessao() {
  return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
}

/**
 * Organizações que o usuário administra.
 *
 * Consultada dentro da transação para que a própria RLS a limite: um VIEWER não
 * consegue enumerar organizações às quais não pertence.
 */
async function orgsQueAdministra(cliente: any, userId: number | string): Promise<number[]> {
  const res = await cliente.query(
    `SELECT organization_id FROM memberships
      WHERE user_id = $1 AND role = 'STORE_ADMIN'`,
    [userId],
  );
  return res.rows.map((r: any) => Number(r.organization_id));
}

/**
 * GET — lista as lojas visíveis.
 *
 * Sem filtro explícito: a RLS entrega apenas as lojas das organizações a que o
 * usuário pertence, e todas para SUPER_ADMIN.
 */
export async function GET(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) return semSessao();

  try {
    const lojas = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const res = await cliente.query(`
        SELECT s.*,
               o.name AS organization_name,
               o.plan AS organization_plan,
               COALESCE((SELECT COUNT(*) FROM appliances a WHERE a.store_id = s.id), 0)::integer AS appliance_count,
               COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id), 0)::integer AS event_count
          FROM stores s
          LEFT JOIN organizations o ON o.id = s.organization_id
         ORDER BY o.name NULLS LAST, s.name
      `);
      return res.rows;
    });
    return NextResponse.json(lojas);
  } catch (erro: any) {
    console.error('[stores GET]', erro);
    return NextResponse.json({ error: 'Falha ao listar lojas.' }, { status: 500 });
  }
}

/**
 * POST — cria uma loja.
 *
 * SUPER_ADMIN cria em qualquer organização; STORE_ADMIN apenas na sua. O limite
 * do plano é verificado antes: sem teto, um cliente em trial provisiona sem
 * parar e o custo aparece na fatura antes de aparecer no painel.
 */
export async function POST(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) return semSessao();

  const superAdmin = ehSuperAdmin(sessao.role);
  if (!superAdmin && sessao.role !== STORE_ADMIN) {
    return NextResponse.json(
      { error: 'Apenas administradores podem criar lojas.' },
      { status: 403 },
    );
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { name, location, telegram_bot_token, telegram_chat_id, organization_id } = corpo;
  if (!name) {
    return NextResponse.json({ error: 'Nome da loja é obrigatório.' }, { status: 400 });
  }

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      let orgId = Number(organization_id) || 0;

      if (!superAdmin) {
        const minhas = await orgsQueAdministra(cliente, sessao.id ?? 0);
        if (!minhas.length) {
          return { erro: 'Você não administra nenhuma organização.', status: 403 };
        }
        // Um STORE_ADMIN não escolhe a organização: usa a sua. Aceitar o valor
        // do corpo permitiria criar loja na organização de outro cliente.
        orgId = minhas[0];
      }

      if (!orgId) {
        return { erro: 'organization_id é obrigatório.', status: 400 };
      }

      const limite = await dentroDoLimite(cliente, orgId, 'stores');
      if (!limite.permitido) {
        return {
          erro: `Limite do plano atingido: ${limite.atual}/${limite.limite} lojas.`,
          status: 409,
        };
      }

      // randomUUID é previsível o bastante para um identificador, mas esta é
      // uma credencial que o appliance usa para se autenticar. randomBytes é a
      // fonte adequada.
      const apiKey = 'vc_' + crypto.randomBytes(24).toString('hex');
      const nova = await cliente.query(
        `INSERT INTO stores (organization_id, name, location, telegram_bot_token, telegram_chat_id, api_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, organization_id, name, location, telegram_chat_id, api_key`,
        [orgId, name, location || null, telegram_bot_token || null, telegram_chat_id || null, apiKey],
      );

      await registrarAuditoria(cliente, {
        organizationId: orgId,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'store.create',
        resourceType: 'store',
        resourceId: nova.rows[0].id,
        detail: { name, location },
        ipAddress: ipDaRequisicao(request),
      });

      return { loja: nova.rows[0] };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json(resultado.loja, { status: 201 });
  } catch (erro: any) {
    console.error('[stores POST]', erro);
    return NextResponse.json({ error: 'Falha ao criar loja.' }, { status: 500 });
  }
}

/**
 * PUT — edita uma loja.
 *
 * Não há checagem de "esta loja é minha?" no código. A política de RLS entra no
 * WHERE do UPDATE: uma loja de outra organização simplesmente não é encontrada,
 * e o rowCount volta zero.
 */
export async function PUT(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) return semSessao();

  if (!ehSuperAdmin(sessao.role) && sessao.role !== STORE_ADMIN) {
    return NextResponse.json(
      { error: 'Apenas administradores podem editar lojas.' },
      { status: 403 },
    );
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { id, name, location, telegram_chat_id, operating_hours, business_rules } = corpo;
  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
  }

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const atualizada = await cliente.query(
        `UPDATE stores
            SET name             = COALESCE($2, name),
                location         = COALESCE($3, location),
                telegram_chat_id = COALESCE($4, telegram_chat_id),
                operating_hours  = COALESCE($5, operating_hours),
                business_rules   = COALESCE($6, business_rules)
          WHERE id = $1
        RETURNING id, organization_id, name, location, telegram_chat_id`,
        [
          id,
          name ?? null,
          location ?? null,
          telegram_chat_id ?? null,
          operating_hours ? JSON.stringify(operating_hours) : null,
          business_rules ?? null,
        ],
      );

      if (!atualizada.rowCount) {
        // Pode ser loja inexistente OU de outro inquilino. A mensagem é a mesma
        // de propósito: distinguir os dois casos revelaria quais ids existem.
        return { erro: 'Loja não encontrada.', status: 404 };
      }

      await registrarAuditoria(cliente, {
        organizationId: atualizada.rows[0].organization_id,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'store.update',
        resourceType: 'store',
        resourceId: id,
        detail: { name, location },
        ipAddress: ipDaRequisicao(request),
      });

      return { loja: atualizada.rows[0] };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json(resultado.loja);
  } catch (erro: any) {
    console.error('[stores PUT]', erro);
    return NextResponse.json({ error: 'Falha ao editar loja.' }, { status: 500 });
  }
}

/**
 * DELETE — remove a loja e tudo que depende dela (cascade).
 *
 * Restrito a SUPER_ADMIN: apagar uma loja destrói eventos e appliances, e não é
 * ação que o cliente deva tomar sozinho por um clique no painel.
 */
export async function DELETE(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) return semSessao();
  if (!ehSuperAdmin(sessao.role)) {
    return NextResponse.json(
      { error: 'Apenas SUPER_ADMIN pode excluir lojas.' },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
  }

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const removida = await cliente.query(
        'DELETE FROM stores WHERE id = $1 RETURNING id, organization_id, name',
        [id],
      );
      if (!removida.rowCount) {
        return { erro: 'Loja não encontrada.', status: 404 };
      }

      await registrarAuditoria(cliente, {
        organizationId: removida.rows[0].organization_id,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'store.delete',
        resourceType: 'store',
        resourceId: id,
        // O nome vai no detalhe porque a linha deixou de existir: sem isto, a
        // trilha diria apenas "apagou a loja 7", e ninguém saberia qual era.
        detail: { name: removida.rows[0].name },
        ipAddress: ipDaRequisicao(request),
      });

      return { ok: true };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json({ success: true });
  } catch (erro: any) {
    console.error('[stores DELETE]', erro);
    return NextResponse.json({ error: 'Falha ao excluir loja.' }, { status: 500 });
  }
}
