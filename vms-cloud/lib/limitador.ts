/**
 * Limite de tentativas em memória (janela fixa).
 *
 * Protege login e aceite de convite contra força bruta. Limitação conhecida:
 * na Vercel cada instância tem a sua memória, então o limite vale por instância.
 * Para limite global, o próximo passo é um contador compartilhado no banco ou
 * no Redis. Até lá, este módulo impede o ataque simples, não o distribuído.
 */

interface Janela {
  inicio: number;
  contagem: number;
}

const janelas = new Map<string, Janela>();

export function dentroDoLimite(chave: string, maximo: number, janelaMs: number, agora = Date.now()): boolean {
  const atual = janelas.get(chave);
  if (!atual || agora - atual.inicio >= janelaMs) {
    janelas.set(chave, { inicio: agora, contagem: 1 });
    return true;
  }
  atual.contagem += 1;
  return atual.contagem <= maximo;
}

/** Só para teste: zera o estado entre casos. */
export function limparLimitador(): void {
  janelas.clear();
}
