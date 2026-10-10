import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretarResposta, validarEntrada, ErroDeAnalise } from './analise.ts';

const JPEG = '/9j/4AAQSkZJRgABAQ==';
const AGORA = Date.parse('2026-10-10T12:00:00Z');

function valida(sobrescrever: Record<string, unknown> = {}) {
  return validarEntrada({
    camera_ref: 'cam-1',
    ocorrido_em: '2026-10-10T11:59:00Z',
    imagem_jpeg_base64: JPEG,
    ...sobrescrever,
  }, AGORA);
}

test('aceita resposta bem formada', () => {
  const r = interpretarResposta(JSON.stringify({
    veredicto: 'SUSPEITO', confianca: 0.82, resumo: '  Mão levando item ao bolso.  ', rotulos: ['bolso', 'mão'],
  }));
  assert.equal(r.veredicto, 'SUSPEITO');
  assert.equal(r.confianca, 0.82);
  assert.equal(r.resumo, 'Mão levando item ao bolso.');
  assert.deepEqual(r.rotulos, ['bolso', 'mão']);
});

test('rejeita texto que não é JSON, em vez de inventar um veredito', () => {
  assert.throws(() => interpretarResposta('desculpe, não consigo'), ErroDeAnalise);
});

test('rejeita veredicto fora do vocabulário', () => {
  assert.throws(
    () => interpretarResposta(JSON.stringify({ veredicto: 'FURTO', confianca: 0.9, resumo: 'x', rotulos: [] })),
    /veredicto inválido/,
  );
});

test('rejeita confiança na escala errada, sem corrigir a escala', () => {
  // Um modelo que devolve 0–100 está errado; "consertar" esconderia o erro.
  assert.throws(
    () => interpretarResposta(JSON.stringify({ veredicto: 'SUSPEITO', confianca: 82, resumo: 'x', rotulos: [] })),
    /0–1/,
  );
});

test('rejeita confiança ausente ou não numérica', () => {
  assert.throws(() => interpretarResposta(JSON.stringify({ veredicto: 'CLEAR', resumo: 'x' })), ErroDeAnalise);
  assert.throws(
    () => interpretarResposta(JSON.stringify({ veredicto: 'CLEAR', confianca: '0.9', resumo: 'x' })),
    ErroDeAnalise,
  );
});

test('rejeita resumo vazio', () => {
  assert.throws(
    () => interpretarResposta(JSON.stringify({ veredicto: 'SEM_INDICIO', confianca: 0.5, resumo: '   ' })),
    /resumo ausente/,
  );
});

test('limita resumo e rótulos ao tamanho que a tela aguenta', () => {
  const longo = 'a'.repeat(900);
  const rotulos = Array.from({ length: 25 }, (_, i) => `r${i}`);
  const r = interpretarResposta(JSON.stringify({
    veredicto: 'INCONCLUSIVO', confianca: 0.1, resumo: longo, rotulos,
  }));
  assert.equal(r.resumo.length, 500);
  assert.equal(r.rotulos.length, 10);
});

test('ignora rótulos que não são texto', () => {
  const r = interpretarResposta(JSON.stringify({
    veredicto: 'SEM_INDICIO', confianca: 0.2, resumo: 'ok', rotulos: ['pessoa', 42, null, ''],
  }));
  assert.deepEqual(r.rotulos, ['pessoa']);
});

test('valida entrada completa', () => {
  const r = valida({ camera_nome: 'Corredor B', metadados: { zona: 'A' } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.valor.cameraRef, 'cam-1');
    assert.equal(r.valor.cameraNome, 'Corredor B');
    assert.deepEqual(r.valor.metadados, { zona: 'A' });
  }
});

test('rejeita imagem que não é JPEG', () => {
  const r = valida({ imagem_jpeg_base64: 'iVBORw0KGgo=' }); // PNG
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.erro, /JPEG/);
});

test('rejeita base64 com caracteres inválidos', () => {
  const r = valida({ imagem_jpeg_base64: '/9j/ab cd' });
  assert.equal(r.ok, false);
});

test('rejeita imagem acima de 1,5 MB', () => {
  const r = valida({ imagem_jpeg_base64: '/9j/' + 'A'.repeat(2_000_000) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.erro, /tamanho/);
});

test('rejeita evento no futuro e evento antigo demais', () => {
  const futuro = valida({ ocorrido_em: '2026-10-10T13:00:00Z' });
  const antigo = valida({ ocorrido_em: '2026-10-08T00:00:00Z' });
  assert.equal(futuro.ok, false);
  assert.equal(antigo.ok, false);
});

test('tolera pequeno desvio de relógio no futuro', () => {
  const r = valida({ ocorrido_em: '2026-10-10T12:03:00Z' });
  assert.equal(r.ok, true);
});

test('rejeita camera_ref vazio e corpo que não é objeto', () => {
  assert.equal(valida({ camera_ref: '   ' }).ok, false);
  assert.equal(validarEntrada('texto', AGORA).ok, false);
  assert.equal(validarEntrada([], AGORA).ok, false);
});

test('rejeita metadados acima de 4 KB', () => {
  const r = valida({ metadados: { texto: 'x'.repeat(5000) } });
  assert.equal(r.ok, false);
});
