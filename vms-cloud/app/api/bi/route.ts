import { sessaoDaRequisicao } from '../../../lib/auth';
import { resumoBI } from '../../../lib/bi';
import { comUsuario } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, inteiroDaUrl, json } from '../../../lib/http';

export const dynamic = 'force-dynamic';

const JANELAS_PERMITIDAS = [1, 7, 30, 90];

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  const url = new URL(request.url);
  const pedido = inteiroDaUrl(url.searchParams.get('dias'), 7, 1, 90);
  const dias = JANELAS_PERMITIDAS.includes(pedido) ? pedido : 7;
  const organizationId = idDaUrl(url.searchParams.get('org'));

  try {
    const dados = await comUsuario(sessao.uid, (c) => resumoBI(c, { dias, organizationId }));
    return json(dados);
  } catch (e) {
    return falhaDoBanco(e, 'bi GET');
  }
}
