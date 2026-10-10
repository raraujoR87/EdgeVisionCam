import { NextResponse } from 'next/server';

export function json(corpo: unknown, status = 200) {
  return NextResponse.json(corpo, { status });
}

export function erro(status: number, mensagem: string) {
  return NextResponse.json({ error: mensagem }, { status });
}

/**
 * Traduz erro do banco para resposta HTTP.
 *
 * 42501 = permissão negada, que é o que a RLS devolve quando um INSERT, UPDATE
 * ou DELETE não passa na política. Vira 403 com mensagem de perfil, não 500.
 * Qualquer outra coisa vira 500 genérico: detalhe de SQL não vai para a tela.
 */
export function falhaDoBanco(erroCapturado: unknown, rotulo: string) {
  const codigo = (erroCapturado as { code?: string })?.code;
  if (codigo === '42501') {
    return erro(403, 'Seu perfil não permite esta ação.');
  }
  console.error(`[${rotulo}]`, erroCapturado);
  return erro(500, 'Falha interna. Tente novamente.');
}

export async function lerJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const corpo = await request.json();
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return null;
    return corpo as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Inteiro vindo da URL, com limites. Nunca lança. */
export function inteiroDaUrl(valor: string | null, padrao: number, minimo: number, maximo: number): number {
  const n = Number(valor);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(Math.trunc(n), minimo), maximo);
}

export function idValido(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor > 0;
}

export function idDaUrl(valor: string | null): number | null {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}
