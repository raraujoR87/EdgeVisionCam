import { gerarTokenAleatorio, hashDeToken, sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * Agentes: os equipamentos na loja que enviam eventos.
 *
 * A chave é mostrada UMA vez, na criação. Depois disso o banco só tem o hash e
 * o prefixo. Perdeu a chave? Revogue e crie outra — não existe "ver a chave".
 */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  try {
    const agentes = await comUsuario(sessao.uid, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.site_id, s.name AS local, a.name, a.key_prefix,
                a.last_seen_at, a.revoked_at, a.created_at
           FROM agents a JOIN sites s ON s.id = a.site_id
          ORDER BY s.name, a.name`,
      );
      return r.rows;
    });
    return json({ agentes });
  } catch (e) {
    return falhaDoBanco(e, 'agentes GET');
  }
}

export async function POST(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const siteId = idDaUrl(String(corpo?.site_id ?? ''));
  const nome = typeof corpo?.nome === 'string' ? corpo.nome.trim() : '';
  if (!siteId) return erro(400, 'site_id é obrigatório.');
  if (!nome || nome.length > 120) return erro(400, 'nome é obrigatório (até 120 caracteres).');

  const chave = `vms_ag_${gerarTokenAleatorio(32)}`;

  try {
    const criado = await comUsuario(sessao.uid, async (c) => {
      const local = await c.query('SELECT organization_id FROM sites WHERE id = $1', [siteId]);
      if (!local.rowCount) return null;
      const r = await c.query(
        `INSERT INTO agents (organization_id, site_id, name, key_hash, key_prefix)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, site_id, name, key_prefix, created_at`,
        [local.rows[0].organization_id, siteId, nome, hashDeToken(chave), chave.slice(0, 12)],
      );
      await registrarAuditoria(c, {
        organizationId: local.rows[0].organization_id,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'agente.criado',
        targetType: 'agent',
        targetId: r.rows[0].id,
        detail: { nome, site_id: siteId },
        ipAddress: ipDaRequisicao(request),
      });
      return r.rows[0];
    });
    if (!criado) return erro(404, 'Local não encontrado.');
    return json({ agente: criado, chave }, 201);
  } catch (e) {
    return falhaDoBanco(e, 'agentes POST');
  }
}

export async function DELETE(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const id = idDaUrl(new URL(request.url).searchParams.get('id'));
  if (!id) return erro(400, 'id é obrigatório.');

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const visivel = await c.query('SELECT organization_id, revoked_at FROM agents WHERE id = $1', [id]);
      if (!visivel.rowCount) return 404 as const;
      if (visivel.rows[0].revoked_at) return 200 as const;
      const r = await c.query('UPDATE agents SET revoked_at = now() WHERE id = $1 RETURNING id', [id]);
      if (!r.rowCount) return 403 as const;
      await registrarAuditoria(c, {
        organizationId: visivel.rows[0].organization_id,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'agente.revogado',
        targetType: 'agent',
        targetId: id,
        ipAddress: ipDaRequisicao(request),
      });
      return 200 as const;
    });
    if (resultado === 404) return erro(404, 'Agente não encontrado.');
    if (resultado === 403) return erro(403, 'Seu perfil não permite revogar agentes.');
    return json({ ok: true });
  } catch (e) {
    return falhaDoBanco(e, 'agentes DELETE');
  }
}
