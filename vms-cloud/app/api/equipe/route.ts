import { sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../lib/http';

export const dynamic = 'force-dynamic';

const PAPEIS = ['ADMIN', 'OPERADOR', 'VISUALIZADOR'] as const;

/**
 * Equipe: quem tem acesso a cada organização e com que papel.
 *
 * Duas proteções além da RLS:
 *   - a organização nunca fica sem administrador (rebaixar ou remover o último
 *     ADMIN é bloqueado — senão ninguém mais consegue convidar ninguém);
 *   - toda mudança de papel ou remoção entra na auditoria.
 */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const organizationId = idDaUrl(new URL(request.url).searchParams.get('org'));

  try {
    const membros = await comUsuario(sessao.uid, async (c) => {
      const params: unknown[] = [];
      let onde = '';
      if (organizationId) { params.push(organizationId); onde = 'WHERE m.organization_id = $1'; }
      const r = await c.query(
        `SELECT m.id AS membership_id, m.role, m.organization_id, m.created_at,
                o.name AS organizacao, u.id AS user_id, u.email
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN organizations o ON o.id = m.organization_id
           ${onde}
          ORDER BY o.name, u.email`,
        params,
      );
      return r.rows;
    });
    return json({ membros });
  } catch (e) {
    return falhaDoBanco(e, 'equipe GET');
  }
}

export async function PATCH(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const id = idDaUrl(String(corpo?.membership_id ?? ''));
  const papel = corpo?.role;
  if (!id) return erro(400, 'membership_id é obrigatório.');
  if (!(PAPEIS as readonly unknown[]).includes(papel)) {
    return erro(400, `role inválido. Use: ${PAPEIS.join(', ')}.`);
  }

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const alvo = await c.query(
        `SELECT m.id, m.organization_id, m.role, u.email
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
        [id],
      );
      if (!alvo.rowCount) return { status: 404 as const };
      const { organization_id: orgId, role: anterior, email } = alvo.rows[0];

      if (anterior === 'ADMIN' && papel !== 'ADMIN') {
        const outros = await c.query(
          `SELECT COUNT(*)::int AS n FROM memberships
            WHERE organization_id = $1 AND role = 'ADMIN' AND id <> $2`,
          [orgId, id],
        );
        if (outros.rows[0].n === 0) return { status: 409 as const };
      }

      const r = await c.query(
        'UPDATE memberships SET role = $2 WHERE id = $1 RETURNING id',
        [id, papel],
      );
      if (!r.rowCount) return { status: 403 as const };

      await registrarAuditoria(c, {
        organizationId: orgId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'membro.papel_alterado',
        targetType: 'membership',
        targetId: id,
        detail: { email, de: anterior, para: papel },
        ipAddress: ipDaRequisicao(request),
      });
      return { status: 200 as const };
    });

    if (resultado.status === 404) return erro(404, 'Membro não encontrado.');
    if (resultado.status === 409) {
      return erro(409, 'Esta é a última administração da organização. Promova outra pessoa antes.');
    }
    if (resultado.status === 403) return erro(403, 'Seu perfil não permite alterar papéis.');
    return json({ ok: true });
  } catch (e) {
    return falhaDoBanco(e, 'equipe PATCH');
  }
}

export async function DELETE(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const id = idDaUrl(new URL(request.url).searchParams.get('membership_id'));
  if (!id) return erro(400, 'membership_id é obrigatório.');

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const alvo = await c.query(
        `SELECT m.organization_id, m.role, u.email
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
        [id],
      );
      if (!alvo.rowCount) return 404 as const;
      const { organization_id: orgId, role, email } = alvo.rows[0];

      if (role === 'ADMIN') {
        const outros = await c.query(
          `SELECT COUNT(*)::int AS n FROM memberships
            WHERE organization_id = $1 AND role = 'ADMIN' AND id <> $2`,
          [orgId, id],
        );
        if (outros.rows[0].n === 0) return 409 as const;
      }

      const r = await c.query('DELETE FROM memberships WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) return 403 as const;

      await registrarAuditoria(c, {
        organizationId: orgId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'membro.removido',
        targetType: 'membership',
        targetId: id,
        detail: { email, papel_anterior: role },
        ipAddress: ipDaRequisicao(request),
      });
      return 200 as const;
    });

    if (resultado === 404) return erro(404, 'Membro não encontrado.');
    if (resultado === 409) {
      return erro(409, 'Esta é a última administração da organização. Promova outra pessoa antes.');
    }
    if (resultado === 403) return erro(403, 'Seu perfil não permite remover membros.');
    return json({ ok: true });
  } catch (e) {
    return falhaDoBanco(e, 'equipe DELETE');
  }
}
