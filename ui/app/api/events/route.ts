import { NextResponse } from 'next/server';
import {
  comInquilino, contextoDoToken, registrarAuditoria, ipDaRequisicao, sessaoDaRequisicao,
} from '../tenant';

export const dynamic = 'force-dynamic';

/**
 * Eventos — o que o cliente abre todo dia.
 *
 * Esta rota não existia. A página de eventos consultava o banco direto como
 * Server Component, o que funcionava para o administrador mas deixava o cliente
 * sem API: sem ela não há triagem, não há feedback, e o produto que se vende
 * (alguém olhar um alerta e dizer se procede) não acontece em lugar nenhum.
 *
 * O feedback humano não é enfeite. É o único dado que mede se o sistema acerta,
 * e é o que separa "detectamos 40 eventos" de "acertamos 36 e erramos 4".
 */

const LIMITE_PADRAO = 25;
const LIMITE_MAXIMO = 100;

const VEREDICTOS = ['SUSPICIOUS', 'CLEAR', 'EXCULPATORY'];
const FEEDBACKS = ['TRUE_POSITIVE', 'FALSE_POSITIVE'];

/**
 * GET — lista os eventos visíveis ao solicitante.
 *
 * Sem cláusula de inquilino: a RLS em `events` entrega apenas os das lojas das
 * organizações a que o usuário pertence. Um `?store_id=` de outro cliente
 * devolve vazio, não erro — e não dado.
 */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const bruto = Number(searchParams.get('limit')) || LIMITE_PADRAO;
  const limite = Math.min(Math.max(bruto, 1), LIMITE_MAXIMO);
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);
  const veredicto = searchParams.get('verdict');
  const feedback = searchParams.get('feedback');
  const pendentes = searchParams.get('pendentes') === '1';
  const loja = searchParams.get('store_id');
  const org = searchParams.get('organization_id');

  try {
    const dados = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // O escopo (loja/organização) e o recorte de trabalho (veredicto,
      // pendência) são separados de propósito: o resumo da fila precisa do
      // primeiro e não do segundo, senão "pendentes: 0" apareceria só porque o
      // usuário está olhando a aba dos já julgados.
      const escopo: string[] = [];
      const pEscopo: any[] = [];
      if (loja) {
        pEscopo.push(loja);
        escopo.push(`e.store_id = $${pEscopo.length}`);
      }
      if (org) {
        pEscopo.push(org);
        escopo.push(`e.store_id IN (SELECT id FROM stores WHERE organization_id = $${pEscopo.length})`);
      }

      const condicoes = [...escopo];
      const params = [...pEscopo];

      if (veredicto && VEREDICTOS.includes(veredicto)) {
        params.push(veredicto);
        condicoes.push(`e.verdict = $${params.length}`);
      }
      if (feedback && FEEDBACKS.includes(feedback)) {
        params.push(feedback);
        condicoes.push(`e.human_feedback = $${params.length}`);
      }
      // "Pendentes" é a fila de trabalho real: alertas que ninguém julgou
      // ainda. Sem esse recorte, a triagem vira rolar a lista procurando.
      if (pendentes) condicoes.push('e.human_feedback IS NULL');

      const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
      const ondeEscopo = escopo.length ? `WHERE ${escopo.join(' AND ')}` : '';

      const total = await cliente.query(
        `SELECT COUNT(*)::int AS n FROM events e ${onde}`, params);

      // Contadores da fila, calculados sobre o que o usuário pode ver. Vão no
      // cabeçalho da tela para que ele saiba o tamanho do trabalho antes de
      // começar.
      const resumo = await cliente.query(
        `SELECT COUNT(*) FILTER (WHERE e.human_feedback IS NULL)::int          AS pendentes,
                COUNT(*) FILTER (WHERE e.verdict = 'SUSPICIOUS')::int          AS suspeitos,
                COUNT(*) FILTER (WHERE e.human_feedback = 'TRUE_POSITIVE')::int  AS confirmados,
                COUNT(*) FILTER (WHERE e.human_feedback = 'FALSE_POSITIVE')::int AS falsos,
                COUNT(*) FILTER (WHERE e.analyzed_at >= NOW() - INTERVAL '24 hours')::int AS ultimas_24h
           FROM events e ${ondeEscopo}`,
        pEscopo,
      );

      params.push(limite, offset);
      const lista = await cliente.query(
        `SELECT e.id, e.store_id, e.video_url, e.suspicion_score, e.verdict,
                e.verdict_explanation, e.human_feedback, e.analyzed_at,
                e.telemetry, s.name AS store_name, s.location AS store_location
           FROM events e
           LEFT JOIN stores s ON s.id = e.store_id
           ${onde}
          ORDER BY e.analyzed_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        eventos: lista.rows,
        total: total.rows[0].n,
        resumo: resumo.rows[0],
      };
    });

    return NextResponse.json({ ...dados, limite, offset });
  } catch (erro: any) {
    console.error('[events GET]', erro);
    return NextResponse.json({ error: 'Falha ao listar eventos.' }, { status: 500 });
  }
}

/**
 * PATCH — o fiscal julga um alerta.
 *
 * É a ação central do produto: alguém olha o clipe e diz se procede. Fica
 * auditada porque, num sistema que pode levar à abordagem de uma pessoa,
 * "quem classificou este evento como furto" é uma pergunta que precisa ter
 * resposta — inclusive num eventual questionamento jurídico.
 */
export async function PATCH(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { id, human_feedback } = corpo;
  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
  }
  // null é válido: desfazer uma classificação feita por engano precisa ser
  // possível, ou o fiscal evita julgar por medo de errar.
  if (human_feedback !== null && !FEEDBACKS.includes(human_feedback)) {
    return NextResponse.json(
      { error: `human_feedback inválido. Aceitos: ${FEEDBACKS.join(', ')} ou null.` },
      { status: 400 },
    );
  }

  const contexto = contextoDoToken(sessao);

  try {
    const resultado = await comInquilino(contexto, async (cliente) => {
      const atualizado = await cliente.query(
        `UPDATE events SET human_feedback = $2
          WHERE id = $1
        RETURNING id, store_id, verdict, human_feedback`,
        [id, human_feedback],
      );
      // rowCount zero = evento inexistente OU de outro inquilino. A RLS não
      // distingue os dois, e a resposta também não deve: separá-los revelaria
      // quais ids existem.
      if (!atualizado.rowCount) {
        return { erro: 'Evento não encontrado.', status: 404 };
      }

      const evento = atualizado.rows[0];
      const org = await cliente.query(
        'SELECT organization_id FROM stores WHERE id = $1', [evento.store_id]);
      const organizationId = org.rows[0]?.organization_id ?? null;

      // STORE_VIEWER lê e não julga. O papel que vale é o da associação com
      // ESTA organização, não o `users.role` global: a mesma pessoa pode ser
      // operadora numa rede e apenas observadora em outra, e o token carrega
      // um valor só.
      //
      // A checagem vem depois do UPDATE, dentro da transação: fazer antes
      // exigiria descobrir a organização do evento, o que já é a mesma
      // consulta. O ROLLBACK desfaz a escrita.
      if (!contexto.isSuperAdmin && organizationId != null) {
        const vinculo = await cliente.query(
          `SELECT 1 FROM memberships
            WHERE user_id = $1 AND organization_id = $2
              AND role IN ('STORE_ADMIN', 'STORE_OPERATOR')
            LIMIT 1`,
          [sessao.id ?? 0, organizationId],
        );
        if (!vinculo.rowCount) {
          return {
            erro: 'Seu perfil permite visualizar os eventos, mas não classificá-los.',
            status: 403,
          };
        }
      }

      await registrarAuditoria(cliente, {
        organizationId,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'event.feedback',
        resourceType: 'event',
        resourceId: id,
        detail: { veredicto_ia: evento.verdict, classificacao_humana: human_feedback },
        ipAddress: ipDaRequisicao(request),
      });

      return { evento };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json(resultado.evento);
  } catch (erro: any) {
    console.error('[events PATCH]', erro);
    return NextResponse.json({ error: 'Falha ao registrar a classificação.' }, { status: 500 });
  }
}
