import { Pool } from 'pg';

let pool: Pool | null = null;

/**
 * Erro de configuracao, distinto de um erro de consulta.
 *
 * Existe para que as rotas consigam diferenciar "o banco nao esta configurado"
 * de "a consulta nao encontrou nada" — confundir os dois foi exatamente o que
 * fez o login responder "Credenciais invalidas" num deploy sem DATABASE_URL,
 * mandando o operador procurar defeito na senha.
 */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'DATABASE_URL não definida. Configure a variável de ambiente do projeto ' +
      'e refaça o deploy.'
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

export function isDatabaseNotConfigured(erro: unknown): boolean {
  return erro instanceof DatabaseNotConfiguredError;
}

/**
 * Pool unico do processo.
 *
 * Exportado para que `tenant.ts` reuse esta conexao em vez de abrir a propria:
 * dois pools dobrariam as conexoes contra o Postgres — que no Supabase e um
 * recurso limitado e compartilhado — e duplicariam a logica de SSL, que ja
 * errou uma vez neste projeto.
 */
export function obterPool(): Pool {
  let connectionString = process.env.DATABASE_URL;

  if (connectionString) {
    connectionString = connectionString.trim().replace(/^["']|["']$/g, '');
  }

  // Antes retornava { rows: [], rowCount: 0 } — um "modo mock" silencioso que
  // fazia toda consulta parecer um resultado vazio legitimo.
  if (!connectionString) {
    console.error('[DB] DATABASE_URL não definida.');
    throw new DatabaseNotConfiguredError();
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    });
  }
  return pool;
}

export async function query(text: string, params?: any[]) {
  return obterPool().query(text, params);
}
