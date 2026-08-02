import { PoolClient } from 'pg';
import { obterPool } from './db';
import { TokenPayload } from './auth/tokens';

/**
 * Contexto de inquilino para consultas ao banco.
 *
 * O isolamento entre clientes vivia inteiramente no código: cada rota precisava
 * lembrar de filtrar por `store_id`. Um WHERE esquecido não gera erro — devolve
 * dados de outro cliente. Num SaaS isso é incidente de dados, e é o tipo de
 * defeito que passa em revisão porque a rota "funciona".
 *
 * A Row Level Security do Postgres inverte o modo de falha: sem contexto
 * declarado, a consulta devolve zero linhas em vez de todas. Esquecer passa a
 * quebrar de forma visível.
 *
 * Para a RLS funcionar, o banco precisa saber quem está perguntando. O backend
 * usa um pool com credencial de serviço, então a identidade é declarada por
 * transação com `SET LOCAL`.
 *
 * ## Por que SET LOCAL, e não SET
 *
 * `SET` vale pela sessão inteira. Numa conexão de pool, a sessão sobrevive à
 * requisição e é reaproveitada pela próxima — que herdaria a identidade do
 * usuário anterior. Um cliente veria os dados de quem usou a conexão antes.
 * `SET LOCAL` morre no COMMIT, então o vazamento é impossível por construção.
 */

export interface ContextoInquilino {
  userId: number | string;
  isSuperAdmin: boolean;
  email?: string;
}

export function contextoDoToken(payload: TokenPayload): ContextoInquilino {
  return {
    userId: payload.id ?? 0,
    // O papel legado 'admin' continua sendo aceito enquanto a migração de RBAC
    // não terminar. Ver a dívida técnica em ARQUITETURA.md §7.
    isSuperAdmin: ['SUPER_ADMIN', 'admin'].includes(payload.role),
    email: payload.email,
  };
}

/**
 * Executa `trabalho` numa transação com o contexto de inquilino declarado.
 *
 * Toda leitura de dado pertencente a cliente deve passar por aqui. Consultar
 * fora deste envelope não é um atalho: com RLS ativa, é uma consulta que
 * devolve vazio.
 */
export async function comInquilino<T>(
  contexto: ContextoInquilino,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    // Parametrizado: um userId vindo de token adulterado não pode virar SQL.
    await cliente.query('SELECT set_config($1, $2, true)', [
      'app.user_id',
      String(contexto.userId),
    ]);
    await cliente.query('SELECT set_config($1, $2, true)', [
      'app.is_super_admin',
      contexto.isSuperAdmin ? 'on' : 'off',
    ]);

    const resultado = await trabalho(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    // Devolver ao pool sempre, inclusive em erro. Sem isto o pool esgota sob
    // carga e o sintoma aparece como lentidão geral, não como bug desta rota.
    cliente.release();
  }
}

/**
 * Registra uma ação na trilha de auditoria.
 *
 * Governança de SaaS exige responder "quem apagou esta loja?" e "quando este
 * usuário virou administrador?". Sem registro, a resposta é sempre "não sei" —
 * e num contrato empresarial isso é um problema comercial, não só técnico.
 *
 * Recebe o cliente da transação de propósito: a auditoria tem de ser atômica
 * com a ação auditada. Registrar fora produziria log de coisas que não
 * aconteceram (rollback depois do log) ou ações sem registro (falha ao logar).
 */
export async function registrarAuditoria(
  cliente: PoolClient,
  dados: {
    organizationId?: number | null;
    userId?: number | string | null;
    actorEmail?: string | null;
    action: string;
    resourceType?: string;
    resourceId?: string | number;
    detail?: unknown;
    ipAddress?: string | null;
  },
): Promise<void> {
  await cliente.query(
    `INSERT INTO audit_log
       (organization_id, user_id, actor_email, action, resource_type, resource_id, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      dados.organizationId ?? null,
      dados.userId ?? null,
      dados.actorEmail ?? null,
      dados.action,
      dados.resourceType ?? null,
      dados.resourceId != null ? String(dados.resourceId) : null,
      dados.detail != null ? JSON.stringify(dados.detail) : null,
      dados.ipAddress ?? null,
    ],
  );
}

/**
 * IP do cliente atrás do proxy da Vercel.
 *
 * `x-forwarded-for` pode trazer vários endereços; o primeiro é o cliente
 * original. Registrar a cadeia inteira polui o log com IPs de infraestrutura.
 */
export function ipDaRequisicao(request: Request): string | null {
  const encaminhado = request.headers.get('x-forwarded-for');
  if (encaminhado) return encaminhado.split(',')[0].trim();
  return request.headers.get('x-real-ip');
}

/**
 * Verifica se a organização ainda cabe dentro do plano contratado.
 *
 * Sem teto explícito, um cliente em trial provisiona appliances sem limite —
 * e o custo de infraestrutura aparece na fatura antes de aparecer no painel.
 */
export async function dentroDoLimite(
  cliente: PoolClient,
  organizationId: number,
  recurso: 'stores' | 'appliances',
): Promise<{ permitido: boolean; atual: number; limite: number }> {
  const coluna = recurso === 'stores' ? 'max_stores' : 'max_appliances';
  const org = await cliente.query(
    `SELECT ${coluna} AS limite, status FROM organizations WHERE id = $1`,
    [organizationId],
  );
  if (!org.rowCount) {
    return { permitido: false, atual: 0, limite: 0 };
  }
  if (org.rows[0].status !== 'ativa') {
    return { permitido: false, atual: 0, limite: org.rows[0].limite };
  }

  const contagem = recurso === 'stores'
    ? await cliente.query('SELECT COUNT(*)::int AS n FROM stores WHERE organization_id = $1', [organizationId])
    : await cliente.query(
        `SELECT COUNT(*)::int AS n FROM appliances a
           JOIN stores s ON s.id = a.store_id
          WHERE s.organization_id = $1`,
        [organizationId],
      );

  const atual = contagem.rows[0].n;
  const limite = org.rows[0].limite;
  return { permitido: atual < limite, atual, limite };
}
