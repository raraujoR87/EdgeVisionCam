import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from '../auth/tokens';
import { comInquilino, contextoDoToken } from '../tenant';

export const dynamic = 'force-dynamic';

/**
 * Indicadores para o painel de BI.
 *
 * A versão anterior tinha um vazamento entre inquilinos:
 *
 *     const store_id = searchParams.get('store_id') || payload.store_id;
 *
 * O id vinha da query string sem nenhuma verificação de posse. Qualquer usuário
 * autenticado — inclusive um VIEWER de outro cliente — lia os indicadores de
 * qualquer loja passando `?store_id=`. Não era preciso forjar token nem
 * adivinhar credencial: bastava trocar um número na URL.
 *
 * Agora o filtro é apenas um recorte de exibição; quem decide o que é acessível
 * é a RLS. Pedir uma loja alheia devolve zero linhas em vez de dados.
 */

function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice(7).trim());
  } catch {
    console.error('[analytics] Não foi possível validar o token.');
    return null;
  }
}

export async function GET(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const lojaPedida = searchParams.get('store_id');
  const orgPedida = searchParams.get('organization_id');

  try {
    const dados = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // Filtro nulo significa "tudo que eu posso ver" — e a RLS define o que é
      // isso. Sem contexto declarado o conjunto é vazio, não completo.
      const evento = lojaPedida
        ? { clausula: 'AND e.store_id = $1', params: [lojaPedida] }
        : orgPedida
          ? {
              clausula: 'AND e.store_id IN (SELECT id FROM stores WHERE organization_id = $1)',
              params: [orgPedida],
            }
          : { clausula: '', params: [] as any[] };

      const diario = await cliente.query(
        `SELECT DATE(e.analyzed_at) AS date,
                COUNT(*)::int AS total,
                SUM(CASE WHEN e.verdict = 'SUSPICIOUS' THEN 1 ELSE 0 END)::int AS suspicious,
                SUM(CASE WHEN e.verdict = 'CLEAR' THEN 1 ELSE 0 END)::int AS clear
           FROM events e
          WHERE e.analyzed_at >= NOW() - INTERVAL '7 days' ${evento.clausula}
          GROUP BY DATE(e.analyzed_at)
          ORDER BY DATE(e.analyzed_at) ASC`,
        evento.params,
      );

      // Os dois erros ficam separados de propósito. Num antifurto eles têm
      // custo muito diferente: deixar passar um furto custa mercadoria, acusar
      // um inocente custa o cliente. Uma "taxa de acerto" única esconderia isso.
      const feedback = await cliente.query(
        `SELECT SUM(CASE WHEN e.human_feedback = 'TRUE_POSITIVE'  THEN 1 ELSE 0 END)::int AS true_positives,
                SUM(CASE WHEN e.human_feedback = 'FALSE_POSITIVE' THEN 1 ELSE 0 END)::int AS false_positives,
                COUNT(*)::int AS total_feedback
           FROM events e
          WHERE e.human_feedback IS NOT NULL ${evento.clausula}`,
        evento.params,
      );

      const frota = lojaPedida
        ? { clausula: 'WHERE a.store_id = $1', params: [lojaPedida] }
        : orgPedida
          ? {
              clausula: 'WHERE a.store_id IN (SELECT id FROM stores WHERE organization_id = $1)',
              params: [orgPedida],
            }
          : { clausula: '', params: [] as any[] };

      const fleet = await cliente.query(
        `SELECT COUNT(a.id)::int AS total_appliances,
                SUM(CASE WHEN h.last_seen >= NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END)::int AS online,
                -- "Online sem inferência" é o estado que passa despercebido: o
                -- appliance responde, mas a engine parou. Contá-lo à parte é o
                -- que distingue "no ar" de "funcionando".
                SUM(CASE WHEN h.last_seen >= NOW() - INTERVAL '5 minutes'
                          AND COALESCE(h.inference_ms, 0) > 0 THEN 1 ELSE 0 END)::int AS detectando
           FROM appliances a
           LEFT JOIN hardware_status h ON a.id = h.appliance_id
           ${frota.clausula}`,
        frota.params,
      );

      return { daily: diario.rows, feedback: feedback.rows[0], fleet: fleet.rows[0] };
    });

    return NextResponse.json(dados);
  } catch (erro: any) {
    console.error('[analytics GET]', erro);
    return NextResponse.json({ error: 'Falha ao calcular indicadores.' }, { status: 500 });
  }
}
