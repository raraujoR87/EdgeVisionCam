/**
 * Planos e cotas.
 *
 * Valores de exemplo, para o produto funcionar de ponta a ponta. Ajuste antes
 * de vender: são decisão comercial, não técnica.
 *
 * A cota é aplicada na ingestão — onde o custo acontece (chamada ao modelo e
 * armazenamento de linha). Um teto só na tela não impede ninguém de consumir.
 */

export const PLANOS = {
  trial: { rotulo: 'Trial', max_cameras: 2, eventos_mes: 300 },
  essencial: { rotulo: 'Essencial', max_cameras: 8, eventos_mes: 3_000 },
  profissional: { rotulo: 'Profissional', max_cameras: 32, eventos_mes: 20_000 },
  enterprise: { rotulo: 'Enterprise', max_cameras: 500, eventos_mes: 500_000 },
} as const;

export type Plano = keyof typeof PLANOS;

export function ehPlanoValido(valor: unknown): valor is Plano {
  return typeof valor === 'string' && Object.prototype.hasOwnProperty.call(PLANOS, valor);
}
