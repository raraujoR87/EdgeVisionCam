import { sessaoDaRequisicao } from '../../../../lib/auth';
import { registrarAuditoria, comUsuario, ipDaRequisicao } from '../../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

const REVISOES_PERMITIDAS = ['PROCEDE', 'FALSO_ALARME'] as const;

/**
 * Revisão humana de um evento: o alerta procedia ou foi falso alarme.
 *
 * É o dado que mede se o sistema acerta. Por isso cada revisão — e cada
 * desfazer — entra na auditoria, com quem fez e quando.
 *
 * Três situações distintas, com respostas distintas:
 *   - evento inexistente ou de outra organização: 404 (a RLS não deixa ver);
 *   - evento visível, mas você não pode revisar (visualizador): 403;
 *   - revisado com sucesso: 200.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const id = idDaUrl(params.id);
  if (!id) return erro(400, 'id inválido.');

  const corpo = await lerJson(request);
  if (!corpo || !('revisao' in corpo)) return erro(400, 'revisao é obrigatório (PROCEDE, FALSO_ALARME ou null).');
  const revisao = corpo.revisao;
  if (revisao !== null && !(REVISOES_PERMITIDAS as readonly unknown[]).includes(revisao)) {
    return erro(400, 'revisao inválida.');
  }

  try {
    const resultado = await comUsuario(sessao.uid, async (c) => {
      const visivel = await c.query('SELECT organization_id, verdict FROM events WHERE id = $1', [id]);
      if (!visivel.rowCount) return { status: 404 as const };

      const atualizado = await c.query(
        `UPDATE events
            SET human_verdict = $2, reviewed_by = app_user_id(), reviewed_at = now()
          WHERE id = $1
        RETURNING id, human_verdict, reviewed_at`,
        [id, revisao],
      );
      if (!atualizado.rowCount) return { status: 403 as const };

      await registrarAuditoria(c, {
        organizationId: visivel.rows[0].organization_id,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: revisao ? 'evento.revisado' : 'evento.revisao_desfeita',
        targetType: 'event',
        targetId: id,
        detail: { veredicto_ia: visivel.rows[0].verdict, revisao_humana: revisao },
        ipAddress: ipDaRequisicao(request),
      });
      return { status: 200 as const, evento: atualizado.rows[0] };
    });

    if (resultado.status === 404) return erro(404, 'Evento não encontrado.');
    if (resultado.status === 403) return erro(403, 'Seu perfil pode visualizar eventos, mas não revisá-los.');
    return json(resultado.evento);
  } catch (e) {
    return falhaDoBanco(e, 'eventos PATCH');
  }
}
