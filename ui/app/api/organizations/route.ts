import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from '../auth/tokens';
import {
  comInquilino,
  contextoDoToken,
  registrarAuditoria,
  ipDaRequisicao,
} from '../tenant';
import { ehSuperAdmin, STORE_ADMIN } from '../papeis';
import { PLANOS, Plano, planoValido } from '../planos';

export const dynamic = 'force-dynamic';

/**
 * CRUD de organizações — o inquilino.
 *
 * Esta rota faltava por completo. Sem ela não havia como cadastrar um cliente:
 * o modelo tinha lojas soltas, e cada uma virava um mundo separado. Onboarding
 * de rede era criar N contas desconectadas.
 *
 * A organização é o que assina o contrato. Plano, limites e suspensão vivem
 * aqui porque é aqui que a relação comercial existe — não na loja.
 */


function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice(7).trim());
  } catch {
    console.error('[organizations] Não foi possível validar o token.');
    return null;
  }
}

/**
 * Slug a partir do nome.
 *
 * Vai para URLs e para o subdomínio no futuro, então precisa ser estável e sem
 * acento. O sufixo aleatório evita colisão entre dois clientes de nome parecido
 * sem precisar de uma consulta de unicidade que ainda assim teria corrida.
 */
function gerarSlug(nome: string): string {
  const base = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const sufixo = Math.random().toString(36).slice(2, 8);
  return `${base || 'org'}-${sufixo}`;
}

/**
 * GET — lista as organizações visíveis.
 *
 * SUPER_ADMIN vê todas; os demais veem aquelas às quais pertencem. Quem filtra
 * é a RLS: não há cláusula de inquilino nesta consulta.
 */
export async function GET(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  try {
    const orgs = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const res = await cliente.query(`
        SELECT o.id, o.name, o.slug, o.plan, o.status,
               o.max_stores, o.max_appliances, o.created_at,
               COALESCE((SELECT COUNT(*) FROM stores s
                          WHERE s.organization_id = o.id), 0)::int AS store_count,
               COALESCE((SELECT COUNT(*) FROM appliances a
                           JOIN stores s2 ON s2.id = a.store_id
                          WHERE s2.organization_id = o.id), 0)::int AS appliance_count,
               COALESCE((SELECT COUNT(*) FROM memberships m
                          WHERE m.organization_id = o.id), 0)::int AS member_count,
               -- Sem detecção nas últimas 24h é o sinal de que o cliente está
               -- pagando por algo que parou. Vale mais no painel que o total.
               COALESCE((SELECT COUNT(*) FROM events e
                           JOIN stores s3 ON s3.id = e.store_id
                          WHERE s3.organization_id = o.id
                            AND e.analyzed_at >= NOW() - INTERVAL '24 hours'), 0)::int AS eventos_24h
          FROM organizations o
         ORDER BY o.name
      `);
      return res.rows;
    });
    return NextResponse.json(orgs);
  } catch (erro: any) {
    console.error('[organizations GET]', erro);
    return NextResponse.json({ error: 'Falha ao listar organizações.' }, { status: 500 });
  }
}

/**
 * POST — cadastra um cliente.
 *
 * Só SUPER_ADMIN: criar organização é abrir uma conta, e isso é ato comercial.
 * Cria também a associação do primeiro administrador, quando informado — uma
 * organização sem administrador nasce inutilizável pelo cliente.
 */
export async function POST(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }
  if (!ehSuperAdmin(sessao.role)) {
    return NextResponse.json(
      { error: 'Apenas SUPER_ADMIN pode cadastrar organizações.' },
      { status: 403 },
    );
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { name, plan, admin_user_id } = corpo;
  if (!name) {
    return NextResponse.json({ error: 'name é obrigatório.' }, { status: 400 });
  }

  const planoEscolhido: Plano = planoValido(plan) ? plan : 'trial';
  const limites = PLANOS[planoEscolhido];

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const nova = await cliente.query(
        `INSERT INTO organizations (name, slug, plan, max_stores, max_appliances, status)
         VALUES ($1, $2, $3, $4, $5, 'ativa')
         RETURNING id, name, slug, plan, status, max_stores, max_appliances`,
        [name, gerarSlug(name), planoEscolhido, limites.max_stores, limites.max_appliances],
      );
      const org = nova.rows[0];

      if (admin_user_id) {
        await cliente.query(
          `INSERT INTO memberships (user_id, organization_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [admin_user_id, org.id, STORE_ADMIN],
        );
      }

      await registrarAuditoria(cliente, {
        organizationId: org.id,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'organization.create',
        resourceType: 'organization',
        resourceId: org.id,
        detail: { name, plan: planoEscolhido, admin_user_id: admin_user_id ?? null },
        ipAddress: ipDaRequisicao(request),
      });

      return org;
    });

    return NextResponse.json(resultado, { status: 201 });
  } catch (erro: any) {
    console.error('[organizations POST]', erro);
    return NextResponse.json({ error: 'Falha ao cadastrar organização.' }, { status: 500 });
  }
}

/**
 * PUT — altera plano, status ou nome.
 *
 * Mudar plano recalcula os limites a partir da tabela, em vez de aceitá-los do
 * corpo: aceitar `max_stores` da requisição permitiria a quem alcançasse esta
 * rota comprar um upgrade sem passar pelo comercial.
 */
export async function PUT(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }
  if (!ehSuperAdmin(sessao.role)) {
    return NextResponse.json(
      { error: 'Apenas SUPER_ADMIN pode alterar plano ou status.' },
      { status: 403 },
    );
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { id, name, plan, status } = corpo;
  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
  }
  if (plan && !planoValido(plan)) {
    return NextResponse.json(
      { error: `plan inválido. Aceitos: ${Object.keys(PLANOS).join(', ')}.` },
      { status: 400 },
    );
  }
  if (status && !['ativa', 'suspensa', 'cancelada'].includes(status)) {
    return NextResponse.json(
      { error: 'status inválido. Aceitos: ativa, suspensa, cancelada.' },
      { status: 400 },
    );
  }

  const limites = plan ? PLANOS[plan as Plano] : null;

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const antes = await cliente.query(
        'SELECT plan, status FROM organizations WHERE id = $1',
        [id],
      );
      if (!antes.rowCount) {
        return { erro: 'Organização não encontrada.', status: 404 };
      }

      const atualizada = await cliente.query(
        `UPDATE organizations
            SET name           = COALESCE($2, name),
                plan           = COALESCE($3, plan),
                status         = COALESCE($4, status),
                max_stores     = COALESCE($5, max_stores),
                max_appliances = COALESCE($6, max_appliances)
          WHERE id = $1
        RETURNING id, name, slug, plan, status, max_stores, max_appliances`,
        [
          id,
          name ?? null,
          plan ?? null,
          status ?? null,
          limites?.max_stores ?? null,
          limites?.max_appliances ?? null,
        ],
      );

      await registrarAuditoria(cliente, {
        organizationId: Number(id),
        userId: sessao.id,
        actorEmail: sessao.email,
        // Suspensão é evento comercial e merece ação própria na trilha: quem
        // audita depois procura por isso, não por "organization.update".
        action: status && status !== antes.rows[0].status
          ? `organization.${status}`
          : 'organization.update',
        resourceType: 'organization',
        resourceId: id,
        detail: { de: antes.rows[0], para: { name, plan, status } },
        ipAddress: ipDaRequisicao(request),
      });

      return { org: atualizada.rows[0] };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json(resultado.org);
  } catch (erro: any) {
    console.error('[organizations PUT]', erro);
    return NextResponse.json({ error: 'Falha ao alterar organização.' }, { status: 500 });
  }
}
