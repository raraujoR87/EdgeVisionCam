import { comServico, registrarAuditoria } from './tenant.ts';
import { hashDeToken } from './auth.ts';
import { PLANOS, ehPlanoValido, type Plano } from './planos.ts';
import { ErroDeAnalise, type Analisador, type EntradaEvento } from './analise.ts';

/**
 * Ingestão de eventos vindos de um agente na loja.
 *
 * Caminho de SERVIÇO: não há usuário. O inquilino vem da chave do agente, que é
 * verificada aqui. O corpo da requisição não decide organização nenhuma.
 *
 * Ordem, com a chamada ao modelo FORA da transação: segurar uma conexão de banco
 * durante uma chamada de até 20 segundos esgotaria o pool sob carga.
 *   1. autentica a chave e confere status da organização;
 *   2. aplica a cota do plano (eventos no mês, câmeras);
 *   3. grava o evento como PENDENTE;
 *   4. analisa o frame e grava o veredito — ou FALHOU, com motivo;
 *   5. o frame é descartado ao sair da função. Nada é persistido.
 */

export interface AgenteAutenticado {
  agenteId: number;
  organizationId: number;
  siteId: number;
  orgStatus: string;
  plano: Plano;
}

export class ErroDeCota extends Error {
  readonly status = 403;
}

export class ErroDeAgente extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function autenticarAgente(chaveBruta: string): Promise<AgenteAutenticado | null> {
  if (!chaveBruta.startsWith('vms_ag_')) return null;
  const hash = hashDeToken(chaveBruta);

  return comServico(async (c) => {
    const r = await c.query(
      `SELECT a.id, a.organization_id, a.site_id, o.status, o.plan
         FROM agents a
         JOIN organizations o ON o.id = a.organization_id
        WHERE a.key_hash = $1 AND a.revoked_at IS NULL`,
      [hash],
    );
    if (!r.rowCount) return null;
    const linha = r.rows[0];
    await c.query('UPDATE agents SET last_seen_at = now() WHERE id = $1', [linha.id]);
    const plano = ehPlanoValido(linha.plan) ? linha.plan : 'trial';
    // BIGSERIAL chega do pg como string. Converte aqui, na fronteira, para que o
    // resto do módulo trabalhe com number, como o tipo declara.
    return {
      agenteId: Number(linha.id),
      organizationId: Number(linha.organization_id),
      siteId: Number(linha.site_id),
      orgStatus: linha.status,
      plano,
    };
  });
}

export interface ResultadoIngestao {
  eventoId: number;
  status: 'ANALISADO' | 'FALHOU';
  verdict: string | null;
}

export async function receberEvento(
  agente: AgenteAutenticado,
  entrada: EntradaEvento,
  analisador: Analisador,
): Promise<ResultadoIngestao> {
  if (agente.orgStatus !== 'ativa') {
    throw new ErroDeAgente('organização suspensa', 403);
  }
  const limites = PLANOS[agente.plano];

  const { eventoId, nomeCamera } = await comServico(async (c) => {
    const mes = await c.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE organization_id = $1 AND received_at >= date_trunc('month', now())`,
      [agente.organizationId],
    );
    if (mes.rows[0].n >= limites.eventos_mes) {
      throw new ErroDeCota('cota mensal de eventos do plano atingida');
    }

    const existente = await c.query(
      'SELECT id, name FROM cameras WHERE site_id = $1 AND external_ref = $2',
      [agente.siteId, entrada.cameraRef],
    );
    let cameraId: number;
    let nome: string;
    if (existente.rowCount) {
      cameraId = existente.rows[0].id;
      nome = existente.rows[0].name;
    } else {
      const cameras = await c.query(
        'SELECT COUNT(*)::int AS n FROM cameras WHERE organization_id = $1',
        [agente.organizationId],
      );
      if (cameras.rows[0].n >= limites.max_cameras) {
        throw new ErroDeCota('limite de câmeras do plano atingido');
      }
      nome = entrada.cameraNome ?? entrada.cameraRef;
      const nova = await c.query(
        `INSERT INTO cameras (organization_id, site_id, external_ref, name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [agente.organizationId, agente.siteId, entrada.cameraRef, nome],
      );
      cameraId = nova.rows[0].id;
    }
    await c.query('UPDATE cameras SET last_event_at = $2 WHERE id = $1', [cameraId, entrada.ocorridoEm]);

    const evento = await c.query(
      `INSERT INTO events
         (organization_id, site_id, camera_id, agent_id, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        agente.organizationId,
        agente.siteId,
        cameraId,
        agente.agenteId,
        entrada.ocorridoEm,
        entrada.metadados ? JSON.stringify(entrada.metadados) : null,
      ],
    );
    return { eventoId: Number(evento.rows[0].id), nomeCamera: nome };
  });

  // Fora da transação. O frame existe só nesta variável.
  try {
    const analise = await analisador.analisar({
      jpegBase64: entrada.jpegBase64,
      contexto: `câmera "${nomeCamera}"`,
    });
    await comServico((c) => c.query(
      `UPDATE events
          SET status = 'ANALISADO', verdict = $3, confidence = $4, summary = $5,
              labels = $6, model = $7, analyzed_at = now()
        WHERE id = $1 AND organization_id = $2`,
      [eventoId, agente.organizationId, analise.veredicto, analise.confianca,
        analise.resumo, analise.rotulos, analise.modelo],
    ));
    return { eventoId, status: 'ANALISADO', verdict: analise.veredicto };
  } catch (erro) {
    // Mensagem genérica para o que não é nosso: não vazamos detalhe de rede,
    // chave ou resposta crua do provedor para o banco nem para a tela.
    const motivo = erro instanceof ErroDeAnalise
      ? erro.message
      : 'falha ao chamar o modelo de análise';
    await comServico((c) => c.query(
      `UPDATE events SET status = 'FALHOU', error = $3
        WHERE id = $1 AND organization_id = $2`,
      [eventoId, agente.organizationId, motivo],
    ));
    return { eventoId, status: 'FALHOU', verdict: null };
  }
}

export async function registrarRecebimentoNaAuditoria(
  organizationId: number,
  agenteId: number,
  detalhes: Record<string, unknown>,
): Promise<void> {
  await comServico((c) => registrarAuditoria(c, {
    organizationId,
    actorUserId: null,
    actorEmail: null,
    action: 'agente.configuracao',
    targetType: 'agent',
    targetId: agenteId,
    detail: detalhes,
  }));
}
