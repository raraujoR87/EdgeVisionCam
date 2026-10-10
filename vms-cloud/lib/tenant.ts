import type { PoolClient } from 'pg';
import { obterPool } from './db.ts';

/**
 * Envelope de inquilino.
 *
 * Toda consulta feita EM NOME DE UM USUÁRIO passa por `comUsuario`. Ele:
 *   1. abre transação;
 *   2. assume o papel `vms_app`, que não ignora RLS (`SET LOCAL ROLE`);
 *   3. declara quem está perguntando (`set_config`, parametrizado).
 *
 * Sem o passo 2, a conexão de serviço (`postgres`, com BYPASSRLS) ignoraria
 * toda política e o isolamento seria decorativo — parece seguro, não protege.
 *
 * `SET LOCAL` morre no COMMIT: a identidade não sobrevive à requisição, mesmo
 * com a conexão reaproveitada pelo pool.
 *
 * Caminhos de SERVIÇO (autenticação, aceite de convite, ingestão de agente)
 * usam `comServico`. Eles não têm usuário; o inquilino vem de um credencial
 * verificada (token, chave de agente), nunca do corpo da requisição. Cada um
 * tem teste, e a lista deles é curta de propósito.
 */

const PAPEL_DA_APLICACAO = 'vms_app';

export async function comUsuario<T>(
  userId: number,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(`SET LOCAL ROLE ${PAPEL_DA_APLICACAO}`);
    await cliente.query('SELECT set_config($1, $2, true)', ['app.user_id', String(userId)]);
    const resultado = await trabalho(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function comServico<T>(
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await obterPool().connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabalho(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

export interface RegistroDeAuditoria {
  organizationId?: number | null;
  actorUserId: number | null;
  actorEmail: string | null;
  action: string;
  targetType?: string;
  targetId?: string | number | null;
  detail?: unknown;
  ipAddress?: string | null;
}

/**
 * Grava na trilha dentro da MESMA transação da ação. Fora dela, haveria registro
 * de algo que não aconteceu (rollback depois do log) ou ação sem registro.
 */
export async function registrarAuditoria(cliente: PoolClient, r: RegistroDeAuditoria): Promise<void> {
  await cliente.query(
    `INSERT INTO audit_log
       (organization_id, actor_user_id, actor_email, action, target_type, target_id, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      r.organizationId ?? null,
      r.actorUserId,
      r.actorEmail,
      r.action,
      r.targetType ?? null,
      r.targetId != null ? String(r.targetId) : null,
      r.detail != null ? JSON.stringify(r.detail) : null,
      r.ipAddress ?? null,
    ],
  );
}

/** IP do cliente atrás do proxy. O primeiro da cadeia é o original. */
export function ipDaRequisicao(request: Request): string | null {
  const encaminhado = request.headers.get('x-forwarded-for');
  if (encaminhado) return encaminhado.split(',')[0].trim();
  return request.headers.get('x-real-ip');
}
