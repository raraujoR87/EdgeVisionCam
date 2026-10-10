import { gerarTokenAleatorio, hashDeToken, sessaoDaRequisicao } from '../../../../lib/auth';
import { VALIDADE_CONVITE_MS } from '../../../../lib/convites';
import { ehPlanoValido } from '../../../../lib/planos';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Área do fornecedor: criar clientes, mudar plano e suspender.
 *
 * Só o fornecedor (`is_platform_admin`) passa. A checagem é explícita e também
 * é a RLS de `organizations`: duas barreiras para a mesma regra.
 */
async function ehFornecedor(c: import('pg').PoolClient): Promise<boolean> {
  const r = await c.query('SELECT app_is_platform_admin() AS ok');
  return r.rows[0].ok === true;
}

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      if (!(await ehFornecedor(c))) return null;
      const r = await c.query(
        `SELECT o.id, o.name, o.slug, o.plan, o.status, o.created_at,
                (SELECT COUNT(*)::int FROM memberships m WHERE m.organization_id = o.id) AS membros,
                (SELECT COUNT(*)::int FROM cameras cam WHERE cam.organization_id = o.id) AS cameras,
                (SELECT COUNT(*)::int FROM events e WHERE e.organization_id = o.id
                    AND e.received_at >= date_trunc('month', now())) AS eventos_mes
           FROM organizations o ORDER BY o.created_at DESC`,
      );
      return r.rows;
    });
    if (resultado === null) return erro(403, 'Área restrita ao fornecedor.');
    return json({ organizacoes: resultado });
  } catch (e) {
    return falhaDoBanco(e, 'plataforma GET');
  }
}

/** Cria o cliente e já gera o convite do primeiro administrador. */
export async function POST(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const nome = typeof corpo?.nome === 'string' ? corpo.nome.trim() : '';
  const slug = typeof corpo?.slug === 'string' ? corpo.slug.trim().toLowerCase() : '';
  const plano = corpo?.plano ?? 'trial';
  const emailAdmin = typeof corpo?.email_admin === 'string' ? corpo.email_admin.trim().toLowerCase() : '';
  if (!nome || nome.length > 120) return erro(400, 'nome é obrigatório.');
  if (!SLUG.test(slug)) return erro(400, 'slug inválido: use letras minúsculas, números e hífen (3 a 50 caracteres).');
  if (!ehPlanoValido(plano)) return erro(400, 'plano inválido.');
  if (!EMAIL.test(emailAdmin)) return erro(400, 'email_admin inválido.');

  const token = gerarTokenAleatorio(32);

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      if (!(await ehFornecedor(c))) return { status: 403 as const };
      const org = await c.query(
        'INSERT INTO organizations (name, slug, plan) VALUES ($1, $2, $3) RETURNING id, name, slug, plan, status',
        [nome, slug, plano],
      );
      const orgId = org.rows[0].id;
      await c.query(
        `INSERT INTO invites (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'ADMIN', $3, $4, $5)`,
        [orgId, emailAdmin, hashDeToken(token), sessao.uid, new Date(Date.now() + VALIDADE_CONVITE_MS)],
      );
      await registrarAuditoria(c, {
        organizationId: orgId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'organizacao.criada',
        targetType: 'organization',
        targetId: orgId,
        detail: { nome, slug, plano, admin_convidado: emailAdmin },
        ipAddress: ipDaRequisicao(request),
      });
      return { status: 201 as const, organizacao: org.rows[0] };
    });
    if (resultado.status === 403) return erro(403, 'Área restrita ao fornecedor.');
    return json({
      organizacao: resultado.organizacao,
      link_convite_admin: `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/convite/${token}`,
    }, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return erro(409, 'Já existe um cliente com este slug.');
    return falhaDoBanco(e, 'plataforma POST');
  }
}

export async function PATCH(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const id = idDaUrl(String(corpo?.id ?? ''));
  if (!id) return erro(400, 'id é obrigatório.');

  const plano = corpo?.plano;
  const status = corpo?.status;
  if (plano !== undefined && !ehPlanoValido(plano)) return erro(400, 'plano inválido.');
  if (status !== undefined && !['ativa', 'suspensa'].includes(String(status))) {
    return erro(400, 'status inválido: ativa ou suspensa.');
  }
  if (plano === undefined && status === undefined) return erro(400, 'Nada para alterar.');

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      if (!(await ehFornecedor(c))) return { status: 403 as const };
      const anterior = await c.query('SELECT plan, status FROM organizations WHERE id = $1', [id]);
      if (!anterior.rowCount) return { status: 404 as const };
      const r = await c.query(
        `UPDATE organizations
            SET plan = COALESCE($2, plan), status = COALESCE($3, status)
          WHERE id = $1
        RETURNING id, plan, status`,
        [id, plano ?? null, status ?? null],
      );
      await registrarAuditoria(c, {
        organizationId: id,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'organizacao.alterada',
        targetType: 'organization',
        targetId: id,
        // Suspender não apaga nada: o registro do que mudou é o que fica.
        detail: { de: anterior.rows[0], para: r.rows[0] },
        ipAddress: ipDaRequisicao(request),
      });
      return { status: 200 as const, organizacao: r.rows[0] };
    });
    if (resultado.status === 403) return erro(403, 'Área restrita ao fornecedor.');
    if (resultado.status === 404) return erro(404, 'Cliente não encontrado.');
    return json(resultado.organizacao);
  } catch (e) {
    return falhaDoBanco(e, 'plataforma PATCH');
  }
}
