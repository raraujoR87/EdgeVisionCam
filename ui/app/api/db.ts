import { Pool } from 'pg';

let pool: Pool | null = null;

export async function query(text: string, params?: any[]) {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.warn("⚠️ DATABASE_URL não definida. Executando em modo Offline/Mock.");
    return { rows: [], rowCount: 0 };
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false 
        : { rejectUnauthorized: false }
    });
  }

  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log(`[SQL Query] Executada em ${duration}ms: ${text.substring(0, 100)}...`);
  return res;
}
