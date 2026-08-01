import crypto from 'crypto';

/**
 * Tokens de sessao do modo nuvem.
 *
 * A versao anterior emitia `visioncam_tok_<base64(json)>` e a rota de verify
 * simplesmente decodificava o payload e confiava no campo `email`. Sem
 * assinatura, qualquer pessoa podia montar um token de administrador na mao.
 * Aqui o payload vai acompanhado de um HMAC-SHA256 e de uma validade.
 */

const TOKEN_PREFIX = 'visioncam_tok_';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12h

export interface TokenPayload {
  id?: number | string;
  email: string;
  role: string;
  store_id: number | string | null;
  exp?: number;
}

/**
 * Segredo de assinatura. Falha fechado de proposito: sem AUTH_SECRET o
 * servidor recusa autenticar, em vez de cair num valor padrao que tornaria
 * todos os deploys forjaveis com a mesma chave.
 */
function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET ausente ou curto demais (minimo 32 caracteres). ' +
      'Defina a variavel de ambiente antes de expor a aplicacao.'
    );
  }
  return secret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string): string {
  return crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
}

export function signToken(payload: TokenPayload, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const withExp: TokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(withExp));
  return `${TOKEN_PREFIX}${body}.${sign(body)}`;
}

/**
 * Devolve o payload apenas se a assinatura confere e o token nao expirou.
 * Qualquer entrada malformada resulta em null — nunca lanca para o chamador.
 */
export function verifyToken(token: string): TokenPayload | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const raw = token.slice(TOKEN_PREFIX.length);
  const dot = raw.indexOf('.');
  if (dot < 0) return null;

  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null; // AUTH_SECRET ausente: nada e valido.
  }

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
