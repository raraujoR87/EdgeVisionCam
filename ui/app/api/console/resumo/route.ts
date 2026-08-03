import { NextResponse } from 'next/server';
import { comInquilino, contextoDoToken, sessaoDaRequisicao } from '../../tenant';

export const dynamic = 'force-dynamic';

/**
 * Painel do cliente — o que ele abre de manhã.
 *
 * A pergunta que esta rota responde não é "quantos eventos houve", é
 * **"tem alguma coisa para eu fazer agora, e o sistema está funcionando?"**.
 *
 * Os dois lados importam igualmente. Um antifurto que parou de detectar não
 * gera alerta nenhum — a tela fica calma e vazia, exatamente igual a uma loja
 * tranquila. Por isso a saúde dos dispositivos vem junto, e não numa aba
 * separada que ninguém abre.
 *
 * Nenhuma cláusula de inquilino: a RLS recorta tudo pelas organizações do
 * solicitante. Um `store_id` de outro cliente devolve vazio.
 */

/** Sem telemetria por mais que isto, o appliance é tratado como fora do ar. */
const MINUTOS_ATE_OFFLINE = 15;

/** Dias da série do painel. Duas semanas mostram o padrão sem virar relatório. */
const DIAS_DA_SERIE = 14;

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const orgPedida = Number(searchParams.get('organization_id')) || null;

  try {
    const dados = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // Recorte opcional por organização, para quem pertence a mais de uma.
      // Não é controle de acesso — a RLS já garantiu o conjunto; é só um
      // filtro de visualização sobre o que já é visível.
      const filtroOrg = orgPedida ? 'AND s.organization_id = $1' : '';
      const p: any[] = orgPedida ? [orgPedida] : [];

      const fila = await cliente.query(
        `SELECT
           COUNT(*) FILTER (WHERE e.human_feedback IS NULL)::int AS pendentes,
           COUNT(*) FILTER (WHERE e.human_feedback IS NULL
                              AND e.verdict = 'SUSPICIOUS')::int AS pendentes_suspeitos,
           COUNT(*) FILTER (WHERE e.analyzed_at >= NOW() - INTERVAL '24 hours')::int AS eventos_24h,
           COUNT(*) FILTER (WHERE e.analyzed_at >= NOW() - INTERVAL '24 hours'
                              AND e.verdict = 'SUSPICIOUS')::int AS suspeitos_24h,
           COUNT(*) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int  AS confirmados,
           COUNT(*) FILTER (WHERE e.human_feedback = 'FALSE_POSITIVE')::int AS falsos,
           COUNT(*)::int AS total,
           MAX(e.analyzed_at) AS ultimo_evento
         FROM events e
         JOIN stores s ON s.id = e.store_id
        WHERE TRUE ${filtroOrg}`,
        p,
      );

      // Série diária. O generate_series é o que faz um dia sem eventos aparecer
      // como zero em vez de sumir do gráfico — a lacuna é o dado interessante
      // quando um appliance cai.
      //
      // O recorte vai dentro da subconsulta, não no WHERE externo: aplicado
      // fora, ele descartaria também as linhas dos dias sem evento, que é
      // justamente o que o LEFT JOIN existe para preservar.
      const serie = await cliente.query(
        `WITH dias AS (
           SELECT generate_series(
             (NOW() - INTERVAL '${DIAS_DA_SERIE - 1} days')::date, NOW()::date, '1 day'
           )::date AS dia
         ), recentes AS (
           SELECT e.id, e.analyzed_at, e.verdict, e.human_feedback
             FROM events e
             JOIN stores s ON s.id = e.store_id
            WHERE e.analyzed_at >= NOW() - INTERVAL '${DIAS_DA_SERIE} days' ${filtroOrg}
         )
         SELECT d.dia,
                COUNT(r.id)::int AS total,
                COUNT(r.id) FILTER (WHERE r.verdict = 'SUSPICIOUS')::int AS suspeitos,
                COUNT(r.id) FILTER (WHERE r.human_feedback = 'TRUE_POSITIVE')::int AS confirmados
           FROM dias d
           LEFT JOIN recentes r ON r.analyzed_at::date = d.dia
          GROUP BY d.dia
          ORDER BY d.dia`,
        p,
      );

      // Uma linha por loja, com o estado do hardware junto. hardware_status não
      // tem RLS própria — o recorte vem do JOIN com appliances, que tem.
      //
      // Subconsultas em vez de um JOIN só: juntar appliances e events na mesma
      // linha multiplica uma pela outra (3 dispositivos × 10 mil eventos = 30
      // mil linhas por loja só para contar). COUNT(DISTINCT) daria o número
      // certo pagando um custo que cresce com o cliente.
      const lojas = await cliente.query(
        `SELECT s.id, s.name, s.location, s.organization_id,
                (SELECT COUNT(*)::int FROM appliances a WHERE a.store_id = s.id) AS appliances,
                (SELECT COUNT(*)::int FROM appliances a
                   JOIN hardware_status h ON h.appliance_id = a.id
                  WHERE a.store_id = s.id
                    AND h.last_seen >= NOW() - INTERVAL '${MINUTOS_ATE_OFFLINE} minutes'
                ) AS appliances_online,
                (SELECT MAX(h.last_seen) FROM appliances a
                   JOIN hardware_status h ON h.appliance_id = a.id
                  WHERE a.store_id = s.id) AS visto_por_ultimo,
                (SELECT COUNT(*)::int FROM events e
                  WHERE e.store_id = s.id
                    AND e.analyzed_at >= NOW() - INTERVAL '24 hours') AS eventos_24h,
                (SELECT COUNT(*)::int FROM events e
                  WHERE e.store_id = s.id AND e.human_feedback IS NULL) AS pendentes,
                (SELECT MAX(e.analyzed_at) FROM events e WHERE e.store_id = s.id) AS ultimo_evento
           FROM stores s
          WHERE TRUE ${filtroOrg}
          ORDER BY s.name`,
        p,
      );

      return {
        fila: fila.rows[0],
        serie: serie.rows,
        lojas: lojas.rows,
      };
    });

    // Alertas operacionais derivados no servidor, para que toda tela que
    // consuma esta rota chegue à mesma conclusão sobre "está funcionando".
    const alertas: { tipo: string; loja: string; detalhe: string }[] = [];
    for (const l of dados.lojas as any[]) {
      if (l.appliances > 0 && l.appliances_online === 0) {
        alertas.push({
          tipo: 'offline',
          loja: l.name,
          detalhe: l.visto_por_ultimo
            ? `Sem comunicação desde ${new Date(l.visto_por_ultimo).toLocaleString('pt-BR')}.`
            : 'O dispositivo nunca reportou telemetria.',
        });
      } else if (l.appliances > 0 && l.eventos_24h === 0) {
        // Online e mudo. Pode ser um dia tranquilo, mas também é como se
        // parece uma câmera desfocada ou apontada para a parede.
        alertas.push({
          tipo: 'sem_deteccao',
          loja: l.name,
          detalhe: 'Dispositivo no ar, nenhum evento nas últimas 24 horas.',
        });
      } else if (l.appliances === 0) {
        alertas.push({
          tipo: 'sem_dispositivo',
          loja: l.name,
          detalhe: 'Nenhum dispositivo instalado nesta loja.',
        });
      }
    }

    return NextResponse.json({ ...dados, alertas, minutos_ate_offline: MINUTOS_ATE_OFFLINE });
  } catch (erro: any) {
    console.error('[console/resumo GET]', erro);
    return NextResponse.json({ error: 'Falha ao carregar o painel.' }, { status: 500 });
  }
}
