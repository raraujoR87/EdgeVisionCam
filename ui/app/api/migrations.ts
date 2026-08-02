import { verifyToken } from './auth/tokens';
import { ehSuperAdmin } from './papeis';

/**
 * Controle de acesso das rotas de migração de schema.
 *
 * As rotas /api/migrate e /api/migrate-rbac executam ALTER TABLE e reescrevem
 * a coluna `role` dos usuários. Elas eram GET sem autenticação nenhuma: qualquer
 * pessoa na internet podia dispará-las. Três consequências, em ordem de
 * gravidade:
 *
 *   1. A migração de RBAC reclassifica papéis. Um atacante que a dispare no
 *      momento certo altera quem é SUPER_ADMIN.
 *   2. ALTER TABLE toma lock. Chamadas repetidas derrubam o banco de todos os
 *      inquilinos — num SaaS multi-tenant, isso é indisponibilidade geral.
 *   3. A mensagem de erro de uma migração expõe nomes de tabelas e colunas.
 *
 * Dois caminhos são aceitos, e nenhum deles tem valor padrão:
 *
 *   - Token de sessão de um SUPER_ADMIN, para o uso normal pelo painel.
 *   - Cabeçalho `x-migration-secret` igual a MIGRATION_SECRET, para o momento
 *     do bootstrap — quando ainda não existe usuário algum e, portanto, não há
 *     token possível. Sem esse caminho, um deploy novo ficaria travado.
 */

const CABECALHO_SEGREDO = 'x-migration-secret';

export interface ResultadoAutorizacao {
  autorizado: boolean;
  motivo: string;
  via?: 'token' | 'segredo';
}

/**
 * Comparação em tempo constante.
 *
 * Um `===` sobre segredos vaza o comprimento do prefixo correto pelo tempo de
 * resposta. Com um endpoint público e sem limite de tentativas, isso é
 * explorável na prática.
 */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}

export function autorizarMigracao(request: Request): ResultadoAutorizacao {
  const cabecalho = request.headers.get('Authorization') || '';
  if (cabecalho.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(cabecalho.slice(7).trim());
      if (payload && ehSuperAdmin(payload.role)) {
        return { autorizado: true, motivo: 'Token de SUPER_ADMIN.', via: 'token' };
      }
      return {
        autorizado: false,
        motivo: 'Token válido, mas o papel não permite migrar o schema.',
      };
    } catch {
      // verifyToken lança quando AUTH_SECRET está ausente. Não é o mesmo caso
      // que token inválido, e confundir os dois esconde erro de configuração.
      return { autorizado: false, motivo: 'Não foi possível validar o token.' };
    }
  }

  const enviado = request.headers.get(CABECALHO_SEGREDO) || '';
  const esperado = process.env.MIGRATION_SECRET || '';

  if (!esperado) {
    // Falha fechada: sem o segredo configurado, a rota não abre nem para o
    // bootstrap. É preferível a um deploy que aceite qualquer chamada.
    return {
      autorizado: false,
      motivo:
        'MIGRATION_SECRET não configurada. Defina-a no ambiente para permitir ' +
        'a migração inicial, ou autentique-se como SUPER_ADMIN.',
    };
  }

  if (enviado && iguaisEmTempoConstante(enviado, esperado)) {
    return { autorizado: true, motivo: 'Segredo de migração.', via: 'segredo' };
  }

  return {
    autorizado: false,
    motivo: 'Requer token de SUPER_ADMIN ou o cabeçalho x-migration-secret.',
  };
}
