import { sessaoDaRequisicao, gerarTokenAleatorio, hashDeToken } from '../../../lib/auth';
import { VALIDADE_CONVITE_MS } from '../../../lib/convites';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../lib/http';

export const dynamic = 'force-dynamic';

const PAPEIS = ['ADMIN', 'OPERADOR', 'VISUALIZADOR'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function urlPublica(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/** Convites pendentes. O token nunca é listado: só existe na resposta da criação. */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  try {
    const convites = await comUsuario(sessao.uid, async (c) => {
      const r = await c.query(
        `SELECT i.id, i.email, i.role, i.expires_at, i.created_at, i.organization_id,
                o.name AS organizacao
           FROM invites i JOIN organizations o ON o.id = i.organization_id
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          ORDER BY i.created_at DESC`,
      );
      return r.rows;
    });
    return json({ convites });
  } catch (e) {
    return falhaDoBanco(e, 'convites GET');
  }
}

/**
 * Cria um convite e devolve o link UMA vez. Não há envio de e-mail: quem convida
 * entrega o link. Isso fica explícito na tela.
 */
export async function POST(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const email = typeof corpo?.email === 'string' ? corpo.email.trim().toLowerCase() : '';
  const papel = corpo?.role;
  const organizationId = idDaUrl(String(corpo?.organization_id ?? ''));
  if (!EMAIL.test(email) || email.length > 254) return erro(400, 'E-mail inválido.');
  if (!(PAPEIS as readonly unknown[]).includes(papel)) {
    return erro(400, `role inválido. Use: ${PAPEIS.join(', ')}.`);
  }
  if (!organizationId) return erro(400, 'organization_id é obrigatório.');

  const token = gerarTokenAleatorio(32);
  const expiraEm = new Date(Date.now() + VALIDADE_CONVITE_MS);

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const jaMembro = await c.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND u.email = $2`,
        [organizationId, email],
      );
      if (jaMembro.rowCount) return { status: 409 as const };

      const r = await c.query(
        `INSERT INTO invites (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, expires_at`,
        [organizationId, email, papel, hashDeToken(token), sessao.uid, expiraEm],
      );
      await registrarAuditoria(c, {
        organizationId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'convite.criado',
        targetType: 'invite',
        targetId: r.rows[0].id,
        detail: { email, role: papel },
        ipAddress: ipDaRequisicao(request),
      });
      return { status: 201 as const, expiraEm: r.rows[0].expires_at };
    });

    if (resultado.status === 409) return erro(409, 'Esta pessoa já pertence à organização.');
    return json({
      link: `${urlPublica()}/convite/${token}`,
      expira_em: resultado.expiraEm,
    }, 201);
  } catch (e) {
    return falhaDoBanco(e, 'convites POST');
  }
}

export async function DELETE(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const id = idDaUrl(new URL(request.url).searchParams.get('id'));
  if (!id) return erro(400, 'id é obrigatório.');
  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const visivel = await c.query('SELECT organization_id, email FROM invites WHERE id = $1', [id]);
      if (!visivel.rowCount) return 404 as const;
      const r = await c.query('UPDATE invites SET revoked_at = now() WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) return 403 as const;
      await registrarAuditoria(c, {
        organizationId: visivel.rows[0].organization_id,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'convite.cancelado',
        targetType: 'invite',
        targetId: id,
        detail: { email: visivel.rows[0].email },
        ipAddress: ipDaRequisicao(request),
      });
      return 200 as const;
    });
    if (resultado === 404) return erro(404, 'Convite não encontrado.');
    if (resultado === 403) return erro(403, 'Seu perfil não permite cancelar convites.');
    return json({ ok: true });
  } catch (e) {
    return falhaDoBanco(e, 'convites DELETE');
  }
}
