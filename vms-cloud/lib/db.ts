import { Pool } from 'pg';
import type { PoolClient } from 'pg';

/**
 * Pool único por processo. Em serverless, cada instância mantém o seu; por isso
 * o `max` é baixo e o cliente é devolvido sempre, inclusive em erro.
 */
let pool: Pool | null = null;

export function obterPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL ausente. Defina a variável antes de subir o servidor.');
    }
    pool = new Pool({ connectionString: url, max: 5 });
  }
  return pool;
}

export type { PoolClient };
