/**
 * Papéis do sistema — fonte única.
 *
 * O papel legado `'admin'` nasceu antes do RBAC e convive com `SUPER_ADMIN`.
 * A checagem `['admin', 'SUPER_ADMIN'].includes(role)` estava replicada em
 * cinco arquivos, e replicação de regra de autorização é como um caminho fica
 * mais permissivo que os outros sem ninguém notar — basta alguém corrigir
 * quatro dos cinco.
 *
 * Centralizar aqui não elimina a dívida; torna-a removível. Quando a migração
 * de RBAC tiver rodado em todos os ambientes, apagar `'admin'` desta lista
 * fecha o assunto num lugar só.
 */

export const PAPEL_LEGADO_ADMIN = 'admin';

export const SUPER_ADMIN = 'SUPER_ADMIN';
export const STORE_ADMIN = 'STORE_ADMIN';
export const STORE_OPERATOR = 'STORE_OPERATOR';
export const STORE_VIEWER = 'STORE_VIEWER';

/** Papéis atribuíveis a um membro de organização. Não inclui SUPER_ADMIN. */
export const PAPEIS_DE_ORGANIZACAO = [
  STORE_ADMIN,
  STORE_OPERATOR,
  STORE_VIEWER,
] as const;

export type PapelDeOrganizacao = (typeof PAPEIS_DE_ORGANIZACAO)[number];

/** Administrador global — enxerga e altera qualquer inquilino. */
export function ehSuperAdmin(role: string | undefined | null): boolean {
  return role === SUPER_ADMIN || role === PAPEL_LEGADO_ADMIN;
}

/** Administra a própria organização. */
export function ehAdminDeOrganizacao(role: string | undefined | null): boolean {
  return role === STORE_ADMIN;
}

/** Pode administrar alguma coisa — global ou dentro da própria organização. */
export function podeAdministrar(role: string | undefined | null): boolean {
  return ehSuperAdmin(role) || ehAdminDeOrganizacao(role);
}

/** Valida um papel vindo de requisição. Lista fechada, de propósito. */
export function papelDeOrganizacaoValido(role: unknown): role is PapelDeOrganizacao {
  return typeof role === 'string' &&
    (PAPEIS_DE_ORGANIZACAO as readonly string[]).includes(role);
}
