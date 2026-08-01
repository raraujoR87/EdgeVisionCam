"""
Testes dos códigos de provisionamento.

O código é digitado por um técnico numa loja, às vezes ditado por telefone.
Isso impõe restrições que uma chave normal não tem — e é justamente onde erros
de transcrição custam uma visita perdida.

Os testes rodam a implementação TypeScript via node, porque duplicá-la em
Python criaria uma segunda definição que divergiria silenciosamente.
"""

import json
import os
import subprocess
import sys

import pytest

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODULO = os.path.join(RAIZ, "ui", "app", "api", "provisioning", "codigo.ts")

pytestmark = pytest.mark.skipif(
    not os.path.exists(os.path.join(RAIZ, "ui", "node_modules")),
    reason="requer ui/node_modules (npm install em ui/)",
)


def executar(script: str):
    """Roda um trecho JS com o módulo de código carregado, devolvendo o JSON."""
    runner = f"""
const {{ execSync }} = require('child_process');
const ts = require('fs').readFileSync({json.dumps(MODULO)}, 'utf-8');
// Converte o módulo TS para CommonJS: são só funções e const, sem tipos em
// runtime, então remover as anotações basta.
const js = ts
  .replace(/import crypto from 'crypto';/, "const crypto = require('crypto');")
  .replace(/export function/g, 'function')
  .replace(/: string\\b/g, '')
  .replace(/: boolean\\b/g, '');
eval(js);
{script}
"""
    saida = subprocess.run(
        ["node", "-e", runner],
        capture_output=True, text=True, cwd=os.path.join(RAIZ, "ui"), timeout=60,
    )
    if saida.returncode != 0:
        raise AssertionError(saida.stderr[-800:])
    return json.loads(saida.stdout.strip())


# ── Geração ────────────────────────────────────────────────────────

def test_formato_do_codigo():
    codigos = executar("console.log(JSON.stringify([...Array(20)].map(gerarCodigo)))")
    for c in codigos:
        assert len(c) == 9 and c[4] == "-", f"formato inesperado: {c}"


def test_codigo_nao_usa_caracteres_ambiguos():
    """
    0/O, 1/I/L, 2/Z, 5/S e 8/B se confundem ao ler em voz alta ou numa etiqueta
    impressa — e um caractere trocado é uma visita técnica perdida.
    """
    codigos = executar("console.log(JSON.stringify([...Array(200)].map(gerarCodigo)))")
    proibidos = set("01258BILOSZ")
    for c in codigos:
        assert not (set(c.replace("-", "")) & proibidos), f"caractere ambíguo em {c}"


def test_codigos_nao_se_repetem():
    codigos = executar("console.log(JSON.stringify([...Array(500)].map(gerarCodigo)))")
    assert len(set(codigos)) == len(codigos)


# ── Normalização ───────────────────────────────────────────────────

@pytest.mark.parametrize(
    "entrada",
    ["ABCD-EFGH", "abcd-efgh", "ABCDEFGH", "abcdefgh", " ABCD EFGH ", "AbCd-EfGh"],
)
def test_normalizacao_aceita_variacoes_de_digitacao(entrada):
    """Quem digita numa tela de celular numa loja não deve ser punido por
    formatação."""
    resultado = executar(f"console.log(JSON.stringify(normalizarCodigo({json.dumps(entrada)})))")
    assert resultado == "ABCD-EFGH"


@pytest.mark.parametrize("entrada", ["", "ABC", "ABCDEFGHI", "ABCD-EFG"])
def test_normalizacao_rejeita_tamanho_errado(entrada):
    resultado = executar(f"console.log(JSON.stringify(normalizarCodigo({json.dumps(entrada)})))")
    assert resultado == ""


# ── Validação ──────────────────────────────────────────────────────

def test_codigo_gerado_e_sempre_valido():
    ok = executar(
        "console.log(JSON.stringify([...Array(100)].map(gerarCodigo).every(codigoValido)))"
    )
    assert ok is True


@pytest.mark.parametrize("entrada", ["ABCD-EFG0", "ABCD-EFGO", "1234-5678", "", "xx"])
def test_codigo_com_caractere_fora_do_alfabeto_e_invalido(entrada):
    assert executar(f"console.log(JSON.stringify(codigoValido({json.dumps(entrada)})))") is False
