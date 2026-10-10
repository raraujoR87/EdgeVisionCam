import { autenticarAgente, ErroDeAgente, ErroDeCota, receberEvento } from '../../../../lib/ingestao';
import { criarAnalisadorGemini, validarEntrada } from '../../../../lib/analise';
import { erro, json, lerJson } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * Entrada de eventos vindos do agente na loja.
 *
 * O agente envia o frame e os metadados. O servidor analisa, grava o veredito e
 * descarta o frame. Nenhum vídeo é guardado.
 *
 * Responde 202 mesmo quando a análise falha: o registro existe e tem o motivo.
 * O agente não deve reenviar o frame — isso gastaria cota e não resolve nada.
 */
export async function POST(request: Request) {
  const cabecalho = request.headers.get('Authorization') || '';
  const chave = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (!chave) return erro(401, 'Chave de agente ausente.');

  try {
    const agente = await autenticarAgente(chave);
    if (!agente) return erro(401, 'Chave de agente inválida ou revogada.');

    const corpo = await lerJson(request);
    if (!corpo) return erro(400, 'Corpo JSON inválido.');
    const validacao = validarEntrada(corpo);
    if (!validacao.ok) return erro(400, validacao.erro);

    const resultado = await receberEvento(agente, validacao.valor, criarAnalisadorGemini());
    return json({
      evento_id: resultado.eventoId,
      status: resultado.status,
      veredito: resultado.verdict,
    }, 202);
  } catch (e) {
    if (e instanceof ErroDeCota) return erro(e.status, e.message);
    if (e instanceof ErroDeAgente) return erro(e.status, e.message);
    console.error('[ingestao eventos]', e);
    return erro(500, 'Falha ao processar o evento.');
  }
}
