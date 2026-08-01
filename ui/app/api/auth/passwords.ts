import crypto from 'crypto';

/**
 * Hashing de senha do console de nuvem.
 *
 * O appliance já migrou para PBKDF2 com salt (core/security.py); a nuvem seguia
 * em SHA-256 puro, que é rápido demais para senha: uma GPU testa bilhões de
 * candidatos por segundo, e sem salt um único rainbow table quebra todos os
 * usuários de todas as lojas de uma vez.
 *
 * O formato e o custo são os mesmos do appliance de propósito — um operador que
 * entenda um lado entende o outro, e a migração de hashes antigos funciona igual
 * nos dois.
 */

const ITERACOES = 260_000;
const PREFIXO = 'pbkdf2_sha256';

/** True para os hashes SHA-256 sem salt gravados por versões anteriores. */
export function ehHashLegado(armazenado: string): boolean {
  return armazenado.length === 64 && !armazenado.startsWith(PREFIXO);
}

export function gerarHash(senha: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto
    .pbkdf2Sync(senha, salt, ITERACOES, 32, 'sha256')
    .toString('hex');
  return `${PREFIXO}$${ITERACOES}$${salt}$${digest}`;
}

/**
 * Confere a senha contra o hash gravado, aceitando tanto PBKDF2 quanto o
 * formato legado. Sempre em tempo constante.
 */
export function conferirSenha(senha: string, armazenado: string): boolean {
  if (!armazenado) return false;

  if (ehHashLegado(armazenado)) {
    const legado = crypto.createHash('sha256').update(senha).digest('hex');
    return comparaSegura(legado, armazenado);
  }

  const partes = armazenado.split('$');
  if (partes.length !== 4 || partes[0] !== PREFIXO) return false;

  const iteracoes = Number.parseInt(partes[1], 10);
  if (!Number.isFinite(iteracoes) || iteracoes <= 0) return false;

  const digest = crypto
    .pbkdf2Sync(senha, partes[2], iteracoes, 32, 'sha256')
    .toString('hex');
  return comparaSegura(digest, partes[3]);
}

function comparaSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  // timingSafeEqual exige mesmo tamanho; comprimentos diferentes já são
  // resposta negativa e não vazam informação útil.
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
