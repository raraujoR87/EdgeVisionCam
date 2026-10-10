import { sessaoDaRequisicao } from '../../../lib/auth';
import { ErroDeAssistente, montarContexto, responder } from '../../../lib/assistente';
import { comUsuario, registrarAuditoria, ipDaRequisicao } from '../../../lib/tenant';
import { dentroDoLimite } from '../../../lib/limitador';
import { erro, falhaDoBanco, idDaUrl, json, lerJson } from '../../../lib/http';

export const dynamic = 'force-dynamic';

const DIAS_PERMITIDOS = [7, 30, 90];

export async function POST(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  if (!dentroDoLimite(`assistente:${sessao.uid}`, 30, 60 * 60 * 1000)) {
    return erro(429, 'Limite de perguntas por hora atingido.');
  }

  const corpo = await lerJson(request);
  const pergunta = typeof corpo?.pergunta === 'string' ? corpo.pergunta.trim() : '';
  if (pergunta.length < 3 || pergunta.length > 500) {
    return erro(400, 'A pergunta precisa ter entre 3 e 500 caracteres.');
  }
  const dias = DIAS_PERMITIDOS.includes(Number(corpo?.dias)) ? Number(corpo?.dias) : 30;
  const organizationId = idDaUrl(String(corpo?.organization_id ?? ''));

  try {
    const contexto = await comUsuario(sessao.uid, async (c) => {
      const texto = await montarContexto(c, dias, organizationId);
      await registrarAuditoria(c, {
        organizationId,
        actorUserId: sessao.uid,
        actorEmail: null,
        action: 'assistente.consulta',
        targetType: 'assistente',
        detail: { dias, tamanho_pergunta: pergunta.length },
        ipAddress: ipDaRequisicao(request),
      });
      return texto;
    });
    const resposta = await responder(pergunta, contexto);
    return json({ resposta, periodo_dias: dias });
  } catch (e) {
    if (e instanceof ErroDeAssistente) return erro(503, e.message);
    return falhaDoBanco(e, 'assistente POST');
  }
}
