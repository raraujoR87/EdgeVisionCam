#!/usr/bin/env node
/**
 * Provisiona o banco do console de nuvem.
 *
 * Substitui os seeds que viviam em shared/schema.sql com credenciais em texto
 * puro. Aqui os valores vem do ambiente e a senha do administrador e gerada na
 * hora, entao nada sensivel entra no repositorio.
 *
 * Uso:
 *   DATABASE_URL=postgres://...  node scripts/seed.mjs
 *   DATABASE_URL=...  ADMIN_EMAIL=admin@empresa.com  node scripts/seed.mjs
 *
 * Variaveis opcionais:
 *   ADMIN_EMAIL      e-mail do administrador global (padrão: admin@visioncam.local)
 *   ADMIN_PASSWORD   senha inicial; se ausente, uma aleatória é gerada e impressa
 *   STORE_NAME       cria uma loja inicial com este nome
 *   TELEGRAM_TOKEN   token do bot de alertas da loja
 *   TELEGRAM_CHAT_ID chat de destino dos alertas
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(AQUI, '..', '..', 'shared', 'schema.sql');

const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERRO: DATABASE_URL não definida.');
    console.error('Exemplo: DATABASE_URL=postgres://user:pass@host/db node scripts/seed.mjs');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? false
      : { rejectUnauthorized: false },
  });

  console.log('=== Provisionando o console de nuvem VisionCam ===\n');

  // 1. Estrutura
  console.log('[1/3] Aplicando shared/schema.sql...');
  await pool.query(fs.readFileSync(SCHEMA, 'utf-8'));
  console.log('      tabelas criadas.');

  // 2. Administrador global
  const email = process.env.ADMIN_EMAIL || 'admin@visioncam.local';
  // Senha aleatoria quando nao informada: melhor um valor impresso uma vez do
  // que um padrao previsivel que ninguem troca.
  const senhaGerada = !process.env.ADMIN_PASSWORD;
  const senha = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');

  console.log(`\n[2/3] Criando administrador ${email}...`);
  const existente = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existente.rowCount > 0) {
    console.log('      já existe — mantido inalterado.');
  } else {
    await pool.query(
      'INSERT INTO users (email, password_hash, store_id, role) VALUES ($1, $2, NULL, $3)',
      [email, sha256(senha), 'admin']
    );
    console.log('      criado.');
  }

  // 3. Loja inicial (opcional)
  const nomeLoja = process.env.STORE_NAME;
  let apiKey = null;
  if (nomeLoja) {
    console.log(`\n[3/3] Criando loja "${nomeLoja}"...`);
    apiKey = `vc_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO stores (name, location, api_key, telegram_bot_token, telegram_chat_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (api_key) DO NOTHING`,
      [
        nomeLoja,
        process.env.STORE_LOCATION || '',
        apiKey,
        process.env.TELEGRAM_TOKEN || null,
        process.env.TELEGRAM_CHAT_ID || null,
      ]
    );
    console.log('      criada.');
  } else {
    console.log('\n[3/3] STORE_NAME não definida — nenhuma loja criada.');
  }

  await pool.end();

  console.log('\n' + '='.repeat(64));
  console.log('PROVISIONAMENTO CONCLUÍDO');
  console.log('='.repeat(64));
  console.log(`  Administrador : ${email}`);
  if (senhaGerada && existente.rowCount === 0) {
    console.log(`  Senha inicial : ${senha}`);
    console.log('                  ^ anote agora; não será exibida de novo.');
  }
  if (apiKey) {
    console.log(`  API key loja  : ${apiKey}`);
    console.log('                  ^ configure no appliance como store_api_key.');
  }
  console.log('='.repeat(64));
}

main().catch((erro) => {
  console.error('\nFalha no provisionamento:', erro.message);
  process.exit(1);
});
