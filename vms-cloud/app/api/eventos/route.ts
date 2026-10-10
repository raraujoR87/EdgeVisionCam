import { sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, inteiroDaUrl, json } from '../../../lib/http';
import { VEREDICTOS } from '../../../lib/analise';

export const dynamic = 'force-dynamic';

/** Filtros de revisão. Lista fechada: o valor nunca vira SQL. */
const REVISOES = {
  todos: null,
  pendente: "e.status = 'ANALISADO' AND e.human_verdict IS NULL",
  procede: "e.human_verdict = 'PROCEDE'",
  falso: "e.human_verdict = 'FALSO_ALARME'",
} as const;

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const url = new URL(request.url);
  const veredicto = url.searchParams.get('veredicto');
  const revisaoPedida = url.searchParams.get('revisao') ?? 'todos';
  const camera = idDaUrl(url.searchParams.get('camera'));
  const organizationId = idDaUrl(url.searchParams.get('org'));
  const limite = inteiroDaUrl(url.searchParams.get('limit'), 25, 1, 100);
  const deslocamento = inteiroDaUrl(url.searchParams.get('offset'), 0, 0, 100_000);

  if (veredicto !== null && !(VEREDICTOS as readonly string[]).includes(veredicto)) {
    return erro(400, 'veredicto inválido.');
  }
  if (!Object.prototype.hasOwnProperty.call(REVISOES, revisaoPedida)) {
    return erro(400, 'revisao inválida. Use: todos, pendente, procede, falso.');
  }
  const condicaoRevisao = REVISOES[revisaoPedida as keyof typeof REVISOES];

  const condicoes: string[] = [];
  const params: unknown[] = [];
  if (veredicto) { params.push(veredicto); condicoes.push(`e.verdict = $${params.length}`); }
  if (condicaoRevisao) condicoes.push(condicaoRevisao);
  if (camera) { params.push(camera); condicoes.push(`e.camera_id = $${params.length}`); }
  if (organizationId) { params.push(organizationId); condicoes.push(`e.organization_id = $${params.length}`); }
  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  try {
    const dados = await comUsuario(sessao.uid, async (c) => {
      const total = await c.query(`SELECT COUNT(*)::int AS n FROM events e ${onde}`, params);
      const lista = await c.query(
        `SELECT e.id, e.organization_id, e.occurred_at, e.received_at, e.status, e.verdict,
                e.confidence, e.summary, e.labels, e.error, e.model, e.metadata,
                e.human_verdict, e.reviewed_at, e.reviewed_by,
                cam.id AS camera_id, cam.name AS camera, s.name AS local,
                o.name AS organizacao
           FROM events e
           JOIN sites s ON s.id = e.site_id
           JOIN organizations o ON o.id = e.organization_id
           LEFT JOIN cameras cam ON cam.id = e.camera_id
           ${onde}
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT ${limite} OFFSET ${deslocamento}`,
        params,
      );
      return { total: total.rows[0].n as number, eventos: lista.rows };
    });
    return json({ ...dados, limite, offset: deslocamento });
  } catch (e) {
    return falhaDoBanco(e, 'eventos GET');
  }
}
