/**
 * Catálogo de comandos remotos aceitos pela frota.
 *
 * ## Por que existe uma lista fechada
 *
 * A tentação, num canal de controle remoto, é aceitar um comando genérico —
 * "rode este shell no appliance" — porque resolve todos os casos de uma vez.
 * O custo aparece depois: a nuvem passa a ser um caminho de execução de código
 * em toda loja do cliente, e um token de administrador vazado deixa de ser
 * "alguém viu o painel" e passa a ser "alguém tem root em N appliances com
 * câmera e gravação dentro".
 *
 * Com uma lista fechada, o pior caso de um token vazado é reiniciar containers
 * e ler log — barulhento, reversível e visível na trilha de auditoria.
 *
 * ## A lista é conferida duas vezes, de propósito
 *
 * Este módulo é a validação da nuvem. O appliance tem a sua própria cópia em
 * `edge/remote_commands.py`, e ele recusa o que não estiver nela — mesmo que a
 * nuvem tenha aceitado. A duplicação é o ponto: se a nuvem for comprometida,
 * o appliance ainda não executa nada fora do conjunto.
 *
 * Por isso o serviço a reiniciar é nomeado por apelido (`engine`, `frigate`,
 * `mqtt`) e não por nome de container: quem traduz apelido em container é o
 * appliance. A nuvem não tem vocabulário para pedir o restart de um container
 * arbitrário do host.
 */

export interface DefinicaoComando {
  /** Texto curto exibido no botão do console. */
  rotulo: string;
  /** O que o operador precisa saber antes de clicar. */
  descricao: string;
  /** Interrompe a detecção enquanto executa — exige confirmação na tela. */
  interrompeDeteccao: boolean;
}

export const COMANDOS: Record<string, DefinicaoComando> = {
  reiniciar_engine: {
    rotulo: 'Reiniciar engine',
    descricao:
      'Reinicia o container de visão. A loja fica sem detecção por cerca de '
      + 'um minuto enquanto os modelos recarregam.',
    interrompeDeteccao: true,
  },
  reiniciar_frigate: {
    rotulo: 'Reiniciar Frigate',
    descricao:
      'Reinicia a captura das câmeras. Use quando o stream travou mas a engine '
      + 'continua de pé.',
    interrompeDeteccao: true,
  },
  reiniciar_mqtt: {
    rotulo: 'Reiniciar MQTT',
    descricao: 'Reinicia o broker de mensagens entre a captura e a engine.',
    interrompeDeteccao: true,
  },
  coletar_logs: {
    rotulo: 'Coletar logs',
    descricao:
      'Traz as últimas linhas de log do serviço escolhido, sem tocar em nada '
      + 'na loja.',
    interrompeDeteccao: false,
  },
  diagnostico: {
    rotulo: 'Diagnóstico',
    descricao:
      'Fotografia do appliance agora: CPU, RAM, estado da NPU, latência de '
      + 'inferência e versão em execução.',
    interrompeDeteccao: false,
  },
};

/** Apelidos de serviço que `coletar_logs` e os restarts aceitam. */
export const SERVICOS = ['engine', 'frigate', 'mqtt'] as const;

export type Servico = (typeof SERVICOS)[number];

/** Teto de linhas de log por comando. */
export const MAX_LINHAS_LOG = 500;

export interface Validacao {
  ok: boolean;
  motivo?: string;
  parametros?: Record<string, unknown>;
}

/**
 * Valida um comando vindo do console e devolve os parâmetros normalizados.
 *
 * Devolve os parâmetros já limpos em vez de aprovar os originais: gravar na
 * fila exatamente o que veio da requisição deixaria campos extras chegarem ao
 * appliance sem que ninguém tivesse olhado para eles.
 */
export function validarComando(comando: string, parametros: unknown): Validacao {
  if (!comando || !Object.prototype.hasOwnProperty.call(COMANDOS, comando)) {
    return { ok: false, motivo: `Comando desconhecido: ${comando || '(vazio)'}.` };
  }

  const entrada = (parametros ?? {}) as Record<string, unknown>;

  if (comando === 'coletar_logs') {
    const servico = String(entrada.servico ?? 'engine');
    if (!(SERVICOS as readonly string[]).includes(servico)) {
      return { ok: false, motivo: `Serviço inválido: ${servico}.` };
    }

    // Number() em vez de parseInt: "150abc" viraria 150 no segundo, e um valor
    // que o operador não digitou não deve virar um pedido válido.
    const bruto = entrada.linhas === undefined ? 150 : Number(entrada.linhas);
    if (!Number.isInteger(bruto) || bruto < 1 || bruto > MAX_LINHAS_LOG) {
      return {
        ok: false,
        motivo: `linhas deve ser um inteiro entre 1 e ${MAX_LINHAS_LOG}.`,
      };
    }

    return { ok: true, parametros: { servico, linhas: bruto } };
  }

  // Os demais comandos não têm parâmetro. Aceitar um objeto qualquer aqui
  // faria a fila carregar dado que o appliance ignora — e que a auditoria
  // registraria como se significasse algo.
  return { ok: true, parametros: {} };
}
