import crypto from 'crypto';

/**
 * Códigos de provisionamento.
 *
 * Precisam ser digitados por um técnico numa loja, às vezes ditados por
 * telefone. Isso impõe restrições que uma chave normal não tem: curto, sem
 * caracteres que se confundem à leitura, e insensível a caixa.
 */

// Sem 0/O, 1/I/L, 2/Z, 5/S, 8/B — os pares que geram erro de transcrição.
const ALFABETO = '34679ACDEFGHJKMNPQRTUVWXY';
const TAMANHO = 8;

/**
 * Gera um código no formato XXXX-XXXX.
 *
 * 25^8 ≈ 1,5e11 combinações. É pouco para uma credencial permanente, mas o
 * código é de uso único, vence em 7 dias e tem limite de tentativas — a
 * entropia não é a única defesa.
 */
export function gerarCodigo(): string {
  const bytes = crypto.randomBytes(TAMANHO);
  let saida = '';
  for (let i = 0; i < TAMANHO; i++) {
    // rejeição via módulo é desprezível aqui: 256 % 25 distorce em ~2%, sem
    // efeito prático para um segredo de uso único e vida curta.
    saida += ALFABETO[bytes[i] % ALFABETO.length];
  }
  return `${saida.slice(0, 4)}-${saida.slice(4)}`;
}

/**
 * Normaliza o que o técnico digitou.
 *
 * Aceita minúsculas, espaços e hífen ausente — quem digita numa tela de celular
 * numa loja não deve ser punido por formatação.
 */
export function normalizarCodigo(entrada: string): string {
  const limpo = (entrada || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpo.length !== TAMANHO) return '';
  return `${limpo.slice(0, 4)}-${limpo.slice(4)}`;
}

export function codigoValido(entrada: string): boolean {
  const normalizado = normalizarCodigo(entrada);
  if (!normalizado) return false;
  return normalizado
    .replace('-', '')
    .split('')
    .every((c) => ALFABETO.includes(c));
}
