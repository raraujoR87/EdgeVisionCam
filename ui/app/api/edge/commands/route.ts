import { NextResponse } from 'next/server';
import { query } from '../../db';

/**
 * Fila de comandos remotos — lado do appliance.
 *
 * Esta é a metade que o appliance chama, autenticada por `x-store-api-key`
 * como a telemetria, e não por sessão de usuário. Duas rotas:
 *
 *   GET   busca os comandos pendentes e os marca como ENTREGUE
 *   POST  devolve o resultado da execução
 *
 * ## Por que a chave aceita aqui é só a do appliance
 *
 * `/api/telemetry` aceita, por compatibilidade, tanto a `edge_key` quanto a
 * `api_key` da loja — e auto-registra um appliance quando vê a segunda. Aquilo
 * é tolerável para ingestão: o pior caso é uma linha de telemetria a mais.
 *
 * Aqui não é. A `api_key` da loja é compartilhada entre appliances; aceitá-la
 * significaria que qualquer aparelho da loja puxa (e consome) o comando
 * destinado a outro, e que uma chave de loja vazada comanda a loja inteira.
 * Esta rota exige `edge_key`, que identifica um appliance e só um.
 *
 * ## Entrega no máximo uma vez
 *
 * O UPDATE ... RETURNING abaixo é atômico: dois polls simultâneos do mesmo
 * appliance não levam o mesmo comando duas vezes. A escolha é entregar no
 * máximo uma vez, não pelo menos uma — um restart perdido custa outro clique,
 * um restart repetido tira a loja do ar de novo sem ninguém ter pedido.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** Estados terminais que o appliance pode reportar. */
const STATUS_FINAIS = ['CONCLUIDO', 'FALHOU'];

/** Teto do corpo de resultado, em caracteres, depois de serializado. */
const MAX_RESULTADO = 64 * 1024;

/**
 * Identifica o appliance pela edge_key.
 *
 * Devolve null sem distinguir "chave inexistente" de "appliance revogado": as
 * duas respostas juntas dariam a quem testa chaves um oráculo para descobrir
 * quais já existiram.
 */
async function autenticar(request: Request) {
  const chave = request.headers.get('x-store-api-key') || '';
  if (!chave) return null;

  const res = await query(
    `SELECT id, store_id, status FROM appliances
      WHERE edge_key = $1 AND edge_key <> ''`,
    [chave],
  );
  if (!res.rowCount || res.rows[0].status !== 'ATIVO') return null;
  return res.rows[0];
}

/** Entrega ao appliance os comandos pendentes que ainda não venceram. */
export async function GET(request: Request) {
  try {
    const appliance = await autenticar(request);
    if (!appliance) {
      return NextResponse.json({ error: 'Chave de API inválida.' }, { status: 401 });
    }

    // Vencer antes de entregar, e não por tarefa agendada: sem um cron, um
    // comando expirado ficaria PENDENTE para sempre na tela. O appliance
    // batendo de dez em dez segundos é o relógio que já existe.
    await query(
      `UPDATE appliance_commands
          SET status = 'EXPIRADO', completed_at = NOW()
        WHERE appliance_id = $1 AND status = 'PENDENTE' AND expires_at <= NOW()`,
      [appliance.id],
    );

    // Entregue e sem resposta. Acontece quando o appliance busca o comando e
    // reinicia antes de reportar — que é o caso normal de `reiniciar_engine`,
    // já que o processo que reportaria é o que morre.
    //
    // Sem esta varredura o comando ficaria ENTREGUE para sempre, e a tela
    // diria "executando" indefinidamente. O desfecho registrado é honesto: o
    // appliance recebeu, e o que houve depois não se sabe.
    await query(
      `UPDATE appliance_commands
          SET status = 'SEM_RESPOSTA', completed_at = NOW(),
              resultado = '{"erro":"O appliance recebeu o comando e não reportou o resultado."}'::jsonb
        WHERE appliance_id = $1 AND status = 'ENTREGUE'
          AND delivered_at < NOW() - INTERVAL '5 minutes'`,
      [appliance.id],
    );

    // Um UPDATE só: marcar entregue e ler o que foi entregue na mesma
    // operação. Ler e depois marcar abriria a janela em que dois polls levam o
    // mesmo comando.
    const res = await query(
      `UPDATE appliance_commands
          SET status = 'ENTREGUE', delivered_at = NOW()
        WHERE id IN (
              SELECT id FROM appliance_commands
               WHERE appliance_id = $1 AND status = 'PENDENTE' AND expires_at > NOW()
               ORDER BY created_at
               LIMIT 5
               FOR UPDATE SKIP LOCKED
        )
      RETURNING id, comando, parametros`,
      [appliance.id],
    );

    return NextResponse.json({ comandos: res.rows });
  } catch (erro: any) {
    console.error('[Edge Commands Poll Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}

/** Recebe o resultado da execução de um comando. */
export async function POST(request: Request) {
  try {
    const appliance = await autenticar(request);
    if (!appliance) {
      return NextResponse.json({ error: 'Chave de API inválida.' }, { status: 401 });
    }

    const { id, status, resultado } = await request.json();

    if (!id || !STATUS_FINAIS.includes(status)) {
      return NextResponse.json(
        { error: `status deve ser um de: ${STATUS_FINAIS.join(', ')}.` },
        { status: 400 },
      );
    }

    // Log de container pode vir grande, e o appliance é quem escolhe o tamanho.
    // Sem teto, um appliance comprometido enche a tabela a custo zero para ele.
    const serializado = JSON.stringify(resultado ?? {});
    if (serializado.length > MAX_RESULTADO) {
      return NextResponse.json(
        { error: `Resultado acima de ${MAX_RESULTADO} caracteres.` },
        { status: 413 },
      );
    }

    // O `appliance_id = $3` é o que impede um appliance de escrever no
    // comando de outro: sem ele, uma edge_key válida fecharia qualquer id da
    // frota. E só ENTREGUE avança — um resultado para um comando cancelado ou
    // já concluído é ruído, não um estado novo.
    const res = await query(
      `UPDATE appliance_commands
          SET status = $1, resultado = $2, completed_at = NOW()
        WHERE id = $3 AND appliance_id = $4 AND status = 'ENTREGUE'
      RETURNING id`,
      [status, serializado, id, appliance.id],
    );

    if (!res.rowCount) {
      return NextResponse.json(
        { error: 'Comando não encontrado, ou não estava aguardando resultado.' },
        { status: 404 },
      );
    }

    return NextResponse.json({ status: 'success' });
  } catch (erro: any) {
    console.error('[Edge Commands Report Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
