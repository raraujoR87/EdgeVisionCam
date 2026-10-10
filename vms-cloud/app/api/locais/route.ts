import { sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../lib/http';

export const dynamic = 'force-dynamic';

/** Locais (lojas, filiais) com suas câmeras e seus agentes. */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const organizationId = idDaUrl(new URL(request.url).searchParams.get('org'));

  try {
    const locais = await comUsuario(sessao.uid, async (c) => {
      const params: unknown[] = [];
      let onde = '';
      if (organizationId) { params.push(organizationId); onde = 'WHERE s.organization_id = $1'; }

      const sites = await c.query(
        `SELECT s.id, s.name, s.address, s.timezone, s.organization_id, o.name AS organizacao
           FROM sites s JOIN organizations o ON o.id = s.organization_id
           ${onde} ORDER BY s.name`,
        params,
      );
      const cameras = await c.query(
        `SELECT cam.id, cam.site_id, cam.name, cam.external_ref, cam.last_event_at
           FROM cameras cam JOIN sites s ON s.id = cam.site_id ${onde}
          ORDER BY cam.name`,
        params,
      );
      // Chave nunca sai daqui: só o prefixo, para o administrador identificar o agente.
      const agentes = await c.query(
        `SELECT a.id, a.site_id, a.name, a.key_prefix, a.last_seen_at, a.revoked_at
           FROM agents a JOIN sites s ON s.id = a.site_id ${onde}
          ORDER BY a.name`,
        params,
      );

      return sites.rows.map((s) => ({
        ...s,
        cameras: cameras.rows.filter((c2) => c2.site_id === s.id),
        agentes: agentes.rows.filter((a) => a.site_id === s.id),
      }));
    });
    return json({ locais });
  } catch (e) {
    return falhaDoBanco(e, 'locais GET');
  }
}

export async function POST(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const corpo = await lerJson(request);
  const nome = typeof corpo?.nome === 'string' ? corpo.nome.trim() : '';
  const organizationId = idDaUrl(String(corpo?.organization_id ?? ''));
  const endereco = typeof corpo?.endereco === 'string' ? corpo.endereco.trim().slice(0, 300) : null;
  if (!nome || nome.length > 120) return erro(400, 'nome é obrigatório (até 120 caracteres).');
  if (!organizationId) return erro(400, 'organization_id é obrigatório.');

  try {
    const criado = await comUsuario(sessao.uid, async (c) => {
      const r = await c.query(
        `INSERT INTO sites (organization_id, name, address) VALUES ($1, $2, $3)
         RETURNING id, name, address, timezone`,
        [organizationId, nome, endereco],
      );
      await registrarAuditoria(c, {
        organizationId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'local.criado',
        targetType: 'site',
        targetId: r.rows[0].id,
        detail: { nome },
        ipAddress: ipDaRequisicao(request),
      });
      return r.rows[0];
    });
    return json(criado, 201);
  } catch (e) {
    return falhaDoBanco(e, 'locais POST');
  }
}
