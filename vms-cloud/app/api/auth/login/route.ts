import { conferirSenha, emitirToken, gerarHashDeSenha } from '../../../../lib/auth';
import { obterPool } from '../../../../lib/db';
import { dentroDoLimite } from '../../../../lib/limitador';
import { erro, json, lerJson } from '../../../../lib/http';
import { ipDaRequisicao } from '../../../../lib/tenant';

export const dynamic = 'force-dynamic';

const MAXIMO_TENTATIVAS = 10;
const JANELA_MS = 15 * 60 * 1000;

let hashFalso: string | null = null;

/**
 * Hash usado quando o e-mail não existe. Gastar o mesmo tempo nos dois casos
 * impede descobrir contas existentes pelo tempo de resposta.
 */
function hashDeReferencia(): string {
  if (!hashFalso) hashFalso = gerarHashDeSenha('referencia-sem-conta');
  return hashFalso;
}

export async function POST(request: Request) {
  const corpo = await lerJson(request);
  const email = typeof corpo?.email === 'string' ? corpo.email.trim().toLowerCase() : '';
  const senha = typeof corpo?.password === 'string' ? corpo.password : '';
  if (!email || !senha) return erro(400, 'E-mail e senha são obrigatórios.');

  const ip = ipDaRequisicao(request) ?? 'desconhecido';
  if (!dentroDoLimite(`login:${email}`, MAXIMO_TENTATIVAS, JANELA_MS) ||
      !dentroDoLimite(`login-ip:${ip}`, MAXIMO_TENTATIVAS * 3, JANELA_MS)) {
    return erro(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  // Conexão de serviço: login acontece antes de existir identidade no banco.
  const r = await obterPool().query(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );
  const usuario = r.rows[0];
  const ok = usuario
    ? conferirSenha(senha, usuario.password_hash)
    : (conferirSenha(senha, hashDeReferencia()), false);

  if (!usuario || !ok) return erro(401, 'E-mail ou senha inválidos.');

  return json({ token: emitirToken(usuario.id), uid: usuario.id });
}
