import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Caminho do agente contra um Postgres de verdade, com um analisador falso.
 *
 * Cobre o que os testes de função pura não cobrem: a autenticação pela chave,
 * a cota gravada, a criação de câmera, o tratamento de falha do modelo e a
 * garantia de que o frame nunca chega ao banco.
 *
 * Pulado quando DATABASE_URL_TESTE não está definida.
 */

const URL_BASE = process.env.DATABASE_URL_TESTE;
const pular = !URL_BASE;

const JPEG = '/9j/4AAQSkZJRgABAQ==';
const MARCADOR_DO_FRAME = JPEG; // se este valor aparecer no banco, o frame vazou

let nomeBanco = '';
let urlTeste = '';

function urlComBanco(url: string, nome: string): string {
  const u = new URL(url);
  u.pathname = `/${nome}`;
  return u.toString();
}

before(async () => {
  if (pular) return;
  nomeBanco = `vms_node_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: URL_BASE });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${nomeBanco}"`);
  await admin.end();

  urlTeste = urlComBanco(URL_BASE!, nomeBanco);
  process.env.DATABASE_URL = urlTeste;
  const c = new Client({ connectionString: urlTeste });
  await c.connect();
  const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf-8');
  await c.query(schema);
  await c.end();
});

after(async () => {
  if (pular) return;
  const { obterPool } = await import('./db.ts');
  await obterPool().end().catch(() => undefined);
  const admin = new Client({ connectionString: URL_BASE });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [nomeBanco]);
  await admin.query(`DROP DATABASE IF EXISTS "${nomeBanco}"`);
  await admin.end();
});

async function sql<T = any>(texto: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: urlTeste });
  await c.connect();
  try {
    return (await c.query(texto, params)).rows;
  } finally {
    await c.end();
  }
}

async function semear(chave: string, plano = 'trial') {
  // Cada caso começa do zero: o id 1 é fixo nas inserções.
  await sql('TRUNCATE events, cameras, agents, sites, organizations RESTART IDENTITY CASCADE');
  const hash = crypto.createHash('sha256').update(chave).digest('hex');
  await sql(`INSERT INTO organizations (id, name, slug, plan) VALUES (1, 'ACME', 'acme', $1)`, [plano]);
  await sql(`INSERT INTO sites (id, organization_id, name) VALUES (1, 1, 'Centro')`);
  await sql(
    `INSERT INTO agents (id, organization_id, site_id, name, key_hash, key_prefix)
     VALUES (1, 1, 1, 'Agente', $1, $2)`,
    [hash, chave.slice(0, 12)],
  );
}

function analisadorFalso(veredicto: 'SUSPEITO' | 'SEM_INDICIO' = 'SUSPEITO') {
  return {
    async analisar() {
      return { veredicto, confianca: 0.87, resumo: 'Resumo de teste', rotulos: ['bolso'], modelo: 'falso' };
    },
  };
}

const entrada = (ref = 'cam-1') => ({
  cameraRef: ref,
  cameraNome: 'Corredor',
  ocorridoEm: new Date(),
  jpegBase64: JPEG,
  metadados: { zona: 'A' },
});

test('recusa chave que não tem o formato de agente, sem consultar o banco', { skip: pular }, async () => {
  const { autenticarAgente } = await import('./ingestao.ts');
  assert.equal(await autenticarAgente('nao-e-uma-chave'), null);
});

test('recusa chave inexistente e aceita a chave certa', { skip: pular }, async () => {
  const chave = `vms_ag_${crypto.randomBytes(16).toString('hex')}`;
  await semear(chave);
  const { autenticarAgente } = await import('./ingestao.ts');
  assert.equal(await autenticarAgente(`vms_ag_${'0'.repeat(32)}`), null);
  const ok = await autenticarAgente(chave);
  assert.ok(ok);
  assert.equal(ok!.organizationId, 1);
  assert.equal(ok!.siteId, 1);
  assert.equal(typeof ok!.organizationId, 'number');
});

test('grava o veredito da IA e cria a câmera na primeira vez', { skip: pular }, async () => {
  const { autenticarAgente, receberEvento } = await import('./ingestao.ts');
  const chave = `vms_ag_${crypto.randomBytes(16).toString('hex')}`;
  await semear(chave);
  const agente = (await autenticarAgente(chave))!;

  const r = await receberEvento(agente, entrada('cam-1'), analisadorFalso('SUSPEITO'));
  assert.equal(r.status, 'ANALISADO');
  assert.equal(r.verdict, 'SUSPEITO');

  const [ev] = await sql('SELECT status, verdict, confidence::float AS confidence, labels FROM events WHERE id = $1', [r.eventoId]);
  assert.equal(ev.status, 'ANALISADO');
  assert.equal(ev.verdict, 'SUSPEITO');
  assert.equal(ev.confidence, 0.87);
  assert.deepEqual(ev.labels, ['bolso']);

  const cams = await sql('SELECT name FROM cameras WHERE external_ref = $1', ['cam-1']);
  assert.equal(cams.length, 1);
  assert.equal(cams[0].name, 'Corredor');
});

test('falha do modelo vira FALHOU com motivo, sem vazar detalhe interno', { skip: pular }, async () => {
  const { autenticarAgente, receberEvento } = await import('./ingestao.ts');
  const { ErroDeAnalise } = await import('./analise.ts');
  const chave = `vms_ag_${crypto.randomBytes(16).toString('hex')}`;
  await semear(chave);
  const agente = (await autenticarAgente(chave))!;

  const resposta = await receberEvento(agente, entrada('cam-2'), {
    async analisar() { throw new ErroDeAnalise('o modelo não devolveu JSON válido'); },
  });
  assert.equal(resposta.status, 'FALHOU');
  const [ev] = await sql('SELECT status, error FROM events WHERE id = $1', [resposta.eventoId]);
  assert.equal(ev.status, 'FALHOU');
  assert.equal(ev.error, 'o modelo não devolveu JSON válido');

  const bruto = await receberEvento(agente, entrada('cam-3'), {
    async analisar() { throw new Error('ECONNRESET api-key=AIza-segredo-123'); },
  });
  const [ev2] = await sql('SELECT error FROM events WHERE id = $1', [bruto.eventoId]);
  assert.equal(ev2.error, 'falha ao chamar o modelo de análise');
  assert.doesNotMatch(ev2.error, /segredo|ECONNRESET|api-key/i);
});

test('cota de câmeras do plano é aplicada na ingestão', { skip: pular }, async () => {
  const { autenticarAgente, receberEvento, ErroDeCota } = await import('./ingestao.ts');
  const chave = `vms_ag_${crypto.randomBytes(16).toString('hex')}`;
  await semear(chave, 'trial'); // trial: 2 câmeras
  const agente = (await autenticarAgente(chave))!;

  await receberEvento(agente, entrada('a'), analisadorFalso());
  await receberEvento(agente, entrada('b'), analisadorFalso());
  await assert.rejects(
    receberEvento(agente, entrada('c'), analisadorFalso()),
    (e: unknown) => e instanceof ErroDeCota && /câmeras/.test((e as Error).message),
  );
});

test('organização suspensa não recebe evento', { skip: pular }, async () => {
  const { receberEvento, ErroDeAgente } = await import('./ingestao.ts');
  const chave = `vms_ag_${crypto.randomBytes(16).toString('hex')}`;
  await semear(chave);
  await assert.rejects(
    receberEvento({
      agenteId: 1, organizationId: 1, siteId: 1, orgStatus: 'suspensa', plano: 'trial',
    }, entrada('x'), analisadorFalso()),
    (e: unknown) => e instanceof ErroDeAgente && e.status === 403,
  );
});

test('o frame nunca chega ao banco: nenhuma linha contém a imagem', { skip: pular }, async () => {
  const linhas = await sql<{ conteudo: string }>(
    `SELECT row_to_json(e)::text AS conteudo FROM events e
     UNION ALL SELECT row_to_json(c)::text FROM cameras c
     UNION ALL SELECT row_to_json(a)::text FROM agents a`,
  );
  assert.ok(linhas.length > 0, 'o teste precisa de linhas para checar');
  for (const l of linhas) {
    assert.ok(!l.conteudo.includes(MARCADOR_DO_FRAME), 'a imagem apareceu em uma linha do banco');
  }
});
