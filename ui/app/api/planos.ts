/**
 * Planos comerciais e seus limites.
 *
 * Fica fora de `organizations/route.ts` por uma restrição do App Router: um
 * arquivo `route.ts` só pode exportar os handlers HTTP (GET/POST/...) e alguns
 * campos de configuração conhecidos (`dynamic`, `revalidate`, `runtime`...).
 * Qualquer outro export falha o build com "não é um campo de Route válido" —
 * e `tsc --noEmit` não acusa, porque a regra é do Next.js, não do TypeScript.
 *
 * Fonte única: a rota valida contra esta tabela e a UI exibe a partir dela.
 * Duplicar os limites nos dois lados deixaria a tela oferecer um plano que a
 * API recusa.
 */

export const PLANOS = {
  trial:        { rotulo: 'Trial',        max_stores: 1,   max_appliances: 2 },
  essencial:    { rotulo: 'Essencial',    max_stores: 3,   max_appliances: 5 },
  profissional: { rotulo: 'Profissional', max_stores: 10,  max_appliances: 25 },
  enterprise:   { rotulo: 'Enterprise',   max_stores: 500, max_appliances: 2000 },
} as const;

export type Plano = keyof typeof PLANOS;

export function planoValido(valor: unknown): valor is Plano {
  return typeof valor === 'string' && valor in PLANOS;
}
