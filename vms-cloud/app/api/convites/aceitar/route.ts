import { aceitarConvite } from '../../../../lib/convites';
import { dentroDoLimite } from '../../../../lib/limitador';
import { erro, json, lerJson } from '../../../../lib/http';
import { ipDaRequisicao } from '../../../../lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Aceite de convite. Único caminho público de escrita, por isso o limite de
 * tentativas: um token adivinhado daria acesso a uma organização.
 */
export async function POST(request: Request) {
  const ip = ipDaRequisicao(request) ?? 'desconhecido';
  if (!dentroDoLimite(`aceite:${ip}`, 20, 15 * 60 * 1000)) {
    return erro(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  const corpo = await lerJson(request);
  const token = typeof corpo?.token === 'string' ? corpo.token : '';
  const senha = typeof corpo?.senha === 'string' ? corpo.senha : null;
  if (!token || token.length > 200) return erro(400, 'token é obrigatório.');

  try {
    const r = await aceitarConvite({ token, senha, ip });
    if (!r.ok) return erro(r.erro.status, r.erro.mensagem);
    return json({ ok: true, email: r.email, conta_nova: r.contaNova });
  } catch (e) {
    console.error('[convites aceitar]', e);
    return erro(500, 'Falha interna. Tente novamente.');
  }
}
