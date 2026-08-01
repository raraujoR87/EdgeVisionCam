/**
 * Classificação de saúde de uma loja.
 *
 * O painel antes só distinguia online de offline por `last_seen`. Mas a
 * telemetria é enviada pelo agente local, que continua vivo mesmo quando a
 * engine de visão morre — então uma loja que parou de detectar aparecia
 * exatamente como uma saudável. É a pior falha possível num produto de
 * segurança: a loja acha que está protegida e não está.
 *
 * `inference_ms` vem da medição real do ciclo de inferência. Presente e maior
 * que zero significa que a engine analisou imagem no último ciclo.
 */

/** Sem sinal por este tempo, o appliance é considerado fora do ar. */
export const MINUTOS_ATE_OFFLINE = 10;

export type SaudeLoja = 'DETECTANDO' | 'CEGA' | 'OFFLINE' | 'NUNCA_CONECTOU';

export interface EstadoHardware {
  last_seen: string | null;
  inference_ms?: number | null;
}

export function classificarLoja(estado: EstadoHardware): SaudeLoja {
  if (!estado.last_seen) return 'NUNCA_CONECTOU';

  const minutos = (Date.now() - new Date(estado.last_seen).getTime()) / 60000;
  if (minutos >= MINUTOS_ATE_OFFLINE) return 'OFFLINE';

  // Appliance reportando, mas sem inferência: container de pé, engine parada.
  // `null` também cai aqui — um appliance em versão antiga não envia o campo, e
  // tratá-lo como saudável esconderia justamente o caso que queremos ver.
  if (!estado.inference_ms || estado.inference_ms <= 0) return 'CEGA';

  return 'DETECTANDO';
}

export const APARENCIA: Record<SaudeLoja, { rotulo: string; classe: string; ponto: string }> = {
  DETECTANDO: {
    rotulo: 'Detectando',
    classe: 'text-emerald-400 font-medium',
    ponto: 'bg-emerald-500 animate-pulse',
  },
  CEGA: {
    // Merece destaque próprio: é o estado que passa despercebido.
    rotulo: 'Online, sem detectar',
    classe: 'text-amber-400 font-bold',
    ponto: 'bg-amber-500 animate-pulse',
  },
  OFFLINE: {
    rotulo: 'Desconectado',
    classe: 'text-rose-400 font-medium',
    ponto: 'bg-rose-500',
  },
  NUNCA_CONECTOU: {
    rotulo: 'Nunca conectado',
    classe: 'text-slate-500',
    ponto: 'bg-slate-800',
  },
};

/** Lojas que exigem ação: fora do ar ou cegas. */
export function lojasComProblema<T extends EstadoHardware>(lojas: T[]): T[] {
  return lojas.filter((l) => {
    const saude = classificarLoja(l);
    return saude === 'OFFLINE' || saude === 'CEGA';
  });
}
