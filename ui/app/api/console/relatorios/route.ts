import { NextResponse } from 'next/server';
import { comInquilino, contextoDoToken, sessaoDaRequisicao } from '../../tenant';

export const dynamic = 'force-dynamic';

/**
 * Relatórios do cliente.
 *
 * O que um lojista leva para a reunião de perdas: quando acontece, onde
 * acontece, e — a métrica que ninguém entrega — **se o sistema está acertando**.
 *
 * A taxa de acerto só existe porque alguém classifica os alertas na triagem.
 * Por isso a cobertura (quantos foram julgados) vem sempre ao lado da precisão:
 * 100% de acerto sobre três eventos julgados de duzentos não é um número, é uma
 * amostra. Mostrar a precisão sozinha seria enganoso, e o cliente tomaria
 * decisão de contrato em cima dela.
 */

/** Janelas oferecidas. Lista fechada: o valor entra numa cláusula de intervalo. */
const JANELAS = [7, 30, 90] as const;

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const pedidos = Number(searchParams.get('dias'));
  const dias = (JANELAS as readonly number[]).includes(pedidos) ? pedidos : 30;
  const loja = Number(searchParams.get('store_id')) || null;
  const org = Number(searchParams.get('organization_id')) || null;

  try {
    const dados = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const cond: string[] = [`e.analyzed_at >= NOW() - INTERVAL '${dias} days'`];
      const p: any[] = [];
      if (loja) { p.push(loja); cond.push(`e.store_id = $${p.length}`); }
      if (org) { p.push(org); cond.push(`s.organization_id = $${p.length}`); }
      // Sem cláusula de inquilino: a RLS em `events` e `stores` já recorta.
      const onde = `WHERE ${cond.join(' AND ')}`;
      const base = `FROM events e JOIN stores s ON s.id = e.store_id ${onde}`;

      const totais = await cliente.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE e.verdict = 'SUSPICIOUS')::int AS suspeitos,
                COUNT(*) FILTER (WHERE e.verdict = 'CLEAR')::int AS liberados,
                COUNT(*) FILTER (WHERE e.verdict = 'EXCULPATORY')::int AS inocentados,
                COUNT(*) FILTER (WHERE e.human_feedback IS NOT NULL)::int AS julgados,
                COUNT(*) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int AS confirmados,
                COUNT(*) FILTER (WHERE e.human_feedback = 'FALSE_POSITIVE')::int AS falsos,
                AVG(e.suspicion_score)::float AS score_medio
         ${base}`,
        p,
      );

      const serie = await cliente.query(
        `WITH dias AS (
           SELECT generate_series(
             (NOW() - INTERVAL '${dias - 1} days')::date, NOW()::date, '1 day'
           )::date AS dia
         ), janela AS (
           SELECT e.id, e.analyzed_at, e.verdict, e.human_feedback ${base}
         )
         SELECT d.dia,
                COUNT(j.id)::int AS total,
                COUNT(j.id) FILTER (WHERE j.verdict = 'SUSPICIOUS')::int AS suspeitos,
                COUNT(j.id) FILTER (WHERE j.human_feedback = 'TRUE_POSITIVE')::int AS confirmados,
                COUNT(j.id) FILTER (WHERE j.human_feedback = 'FALSE_POSITIVE')::int AS falsos
           FROM dias d
           LEFT JOIN janela j ON j.analyzed_at::date = d.dia
          GROUP BY d.dia ORDER BY d.dia`,
        p,
      );

      // Distribuição por hora do dia. É o corte que vira decisão operacional:
      // onde alocar o fiscal, quando reforçar o turno.
      const porHora = await cliente.query(
        `WITH horas AS (SELECT generate_series(0, 23) AS hora)
         SELECT h.hora,
                COUNT(e.id)::int AS total,
                COUNT(e.id) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int AS confirmados
           FROM horas h
           LEFT JOIN (SELECT e.id, e.analyzed_at, e.human_feedback ${base}) e
                  ON EXTRACT(HOUR FROM e.analyzed_at AT TIME ZONE 'America/Sao_Paulo') = h.hora
          GROUP BY h.hora ORDER BY h.hora`,
        p,
      );

      const porLoja = await cliente.query(
        `SELECT s.id, s.name, s.location,
                COUNT(e.id)::int AS total,
                COUNT(e.id) FILTER (WHERE e.verdict = 'SUSPICIOUS')::int AS suspeitos,
                COUNT(e.id) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int AS confirmados,
                COUNT(e.id) FILTER (WHERE e.human_feedback = 'FALSE_POSITIVE')::int AS falsos,
                COUNT(e.id) FILTER (WHERE e.human_feedback IS NULL)::int AS pendentes
         ${base}
          GROUP BY s.id ORDER BY total DESC`,
        p,
      );

      return {
        totais: totais.rows[0],
        serie: serie.rows,
        por_hora: porHora.rows,
        por_loja: porLoja.rows,
      };
    });

    const t: any = dados.totais;
    // Divisões protegidas: `null` significa "ainda não dá para dizer", e a tela
    // mostra um traço. Zero seria uma afirmação falsa sobre um sistema que
    // simplesmente não foi avaliado.
    const precisao = t.julgados > 0 ? t.confirmados / t.julgados : null;
    const cobertura = t.total > 0 ? t.julgados / t.total : null;

    return NextResponse.json({
      periodo: { dias },
      ...dados,
      qualidade: {
        precisao,
        cobertura,
        // Abaixo disto, a precisão é ruído amostral. O número existe; a tela é
        // que precisa dizer que ele ainda não significa nada.
        amostra_suficiente: t.julgados >= 20,
      },
    });
  } catch (erro: any) {
    console.error('[console/relatorios GET]', erro);
    return NextResponse.json({ error: 'Falha ao gerar o relatório.' }, { status: 500 });
  }
}
