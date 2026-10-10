import crypto from 'crypto';

/**
 * Senhas e sessões.
 *
 * Senha: PBKDF2-SHA256 com salt, mesmo formato do appliance. SHA-256 puro é
 * rápido demais para senha — uma GPU testa bilhões de candidatos por segundo.
 *
 * Sessão: `vms_tok_<payload>.<assinatura>`, HMAC-SHA256 com AUTH_SECRET, com
 * validade. O token só diz QUEM é o usuário. O que ele pode ver quem decide é o
 * banco (RLS), consultado a cada requisição — por isso não há papel dentro do
 * token: um papel no token sobreviveria à revogação até expirar.
 */

const ITERACOES = 260_000;
const PREFIXO = 'pbkdf2_sha256';
const PREFIXO_TOKEN = 'vms_tok_';
const VALIDADE_SEGUNDOS = 12 * 60 * 60;

export const TAMANHO_MINIMO_SENHA = 10;

export function gerarHashDeSenha(senha: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(senha, salt, ITERACOES, 32, 'sha256').toString('hex');
  return `${PREFIXO}$${ITERACOES}$${salt}$${digest}`;
}

export function conferirSenha(senha: string, armazenado: string | null): boolean {
  if (!armazenado) return false;
  const partes = armazenado.split('$');
  if (partes.length !== 4 || partes[0] !== PREFIXO) return false;
  const iteracoes = Number.parseInt(partes[1], 10);
  if (!Number.isFinite(iteracoes) || iteracoes <= 0) return false;
  const digest = crypto.pbkdf2Sync(senha, partes[2], iteracoes, 32, 'sha256').toString('hex');
  return comparaSegura(digest, partes[3]);
}

function comparaSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Hash de token de uso único (convite, chave de agente). Alta entropia: SHA-256 basta. */
export function hashDeToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function gerarTokenAleatorio(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function segredo(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error('AUTH_SECRET ausente ou com menos de 32 caracteres.');
  }
  return s;
}

function assinar(corpo: string): string {
  return crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
}

export interface Sessao {
  uid: number;
  exp: number;
}

export function emitirToken(uid: number, agora = Date.now()): string {
  const corpo = Buffer.from(
    JSON.stringify({ uid, exp: Math.floor(agora / 1000) + VALIDADE_SEGUNDOS }),
  ).toString('base64url');
  return `${PREFIXO_TOKEN}${corpo}.${assinar(corpo)}`;
}

/** Devolve a sessão só se a assinatura confere e ainda não expirou. Nunca lança. */
export function lerToken(token: string, agora = Date.now()): Sessao | null {
  if (!token.startsWith(PREFIXO_TOKEN)) return null;
  const bruto = token.slice(PREFIXO_TOKEN.length);
  const ponto = bruto.lastIndexOf('.');
  if (ponto < 0) return null;
  const corpo = bruto.slice(0, ponto);
  const assinatura = bruto.slice(ponto + 1);

  let esperada: string;
  try {
    esperada = assinar(corpo);
  } catch {
    return null;
  }
  if (!comparaSegura(assinatura, esperada)) return null;

  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf-8')) as Sessao;
    if (typeof dados.uid !== 'number' || typeof dados.exp !== 'number') return null;
    if (dados.exp < Math.floor(agora / 1000)) return null;
    return dados;
  } catch {
    return null;
  }
}

export function sessaoDaRequisicao(request: Request): Sessao | null {
  const cabecalho = request.headers.get('Authorization') || '';
  if (!cabecalho.startsWith('Bearer ')) return null;
  return lerToken(cabecalho.slice(7).trim());
}
