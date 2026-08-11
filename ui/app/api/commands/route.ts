import { NextResponse } from 'next/server';
import { isDatabaseNotConfigured } from '../db';
import {
  comInquilino,
  contextoDoToken,
  sessaoDaRequisicao,
  registrarAuditoria,
  ipDaRequisicao,
} from '../tenant';
import { validarComando } from '../comandos';
import { podeAdministrar } from '../papeis';

/**
 * Fila de comandos remotos — lado do console.
 *
 * O appliance mora atrás do NAT da loja. Não existe rota da nuvem até ele, e
 * abrir uma (túnel reverso, VPN, porta encaminhada no roteador do cliente)
 * significaria manter uma porta de entrada em cada loja da frota. Então o
 * sentido do controle é invertido: o console enfileira, o appliance puxa no
 * mesmo loop que já usa para mandar telemetria — ver /api/edge/commands.
 *
 * A consequência a aceitar é que o comando não é instantâneo: ele executa no
 * próximo poll. A tela diz isso, em vez de fingir tempo real.
 */
export const dynamic = 'force-dynamic';

/**
 * Lista os comandos de um appliance.
 *
 * A RLS filtra por organização; o `?appliance_id=` só estreita o que o
 * inquilino já podia ver. Um id de outra organização devolve lista vazia em
 * vez de erro — não há por que confirmar que aquele appliance existe.
 */
export async function GET(request: Request) {
  try {
    const sessao = sessaoDaRequisicao(request);
    if (!sessao) {
      return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const applianceId = searchParams.get('appliance_id');

    const comandos = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const res = await cliente.query(
        `SELECT c.id, c.appliance_id, c.comando, c.parametros, c.status,
                c.resultado, c.issued_email, c.created_at, c.expires_at,
                c.delivered_at, c.completed_at,
                a.label AS appliance_label, s.name AS store_name
           FROM appliance_commands c
           JOIN appliances a ON a.id = c.appliance_id
           JOIN stores s ON s.id = a.store_id
          WHERE ($1::int IS NULL OR c.appliance_id = $1::int)
          ORDER BY c.created_at DESC
          LIMIT 50`,
        [applianceId ? Number(applianceId) : null],
      );
      return res.rows;
    });

    return NextResponse.json({ comandos });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Commands List Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}

/** Enfileira um comando para um appliance. */
export async function POST(request: Request) {
  try {
    const sessao = sessaoDaRequisicao(request);
    // O dono da rede comanda os próprios appliances; a RLS abaixo é o que
    // impede que ele comande os de outra organização. Um VIEWER não passa
    // daqui — ler o painel e reiniciar a loja não são o mesmo poder.
    if (!sessao || !podeAdministrar(sessao.role)) {
      return NextResponse.json(
        { error: 'Somente administradores podem comandar um appliance.' },
        { status: 401 },
      );
    }

    const { appliance_id, comando, parametros } = await request.json();
    if (!appliance_id) {
      return NextResponse.json({ error: 'appliance_id é obrigatório.' }, { status: 400 });
    }

    // Validação antes de tocar no banco: o catálogo é a fronteira do que a
    // nuvem consegue pedir. Ver ui/app/api/comandos.ts.
    const validacao = validarComando(comando, parametros);
    if (!validacao.ok) {
      return NextResponse.json({ error: validacao.motivo }, { status: 400 });
    }

    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // SELECT sob RLS: se o appliance for de outra organização, esta consulta
      // devolve zero linhas e a inserção nunca acontece. O isolamento não
      // depende de um WHERE que alguém possa esquecer aqui.
      const alvo = await cliente.query(
        `SELECT a.id, a.status, s.organization_id
           FROM appliances a JOIN stores s ON s.id = a.store_id
          WHERE a.id = $1`,
        [appliance_id],
      );
      if (!alvo.rowCount) {
        return { erro: 'Appliance não encontrado.', status: 404 };
      }
      if (alvo.rows[0].status !== 'ATIVO') {
        // Um appliance PENDENTE nunca fez poll, e um REVOGADO não deve voltar
        // a executar nada. Enfileirar para eles produziria comandos que só
        // vencem — e uma tela que parece ter funcionado.
        return {
          erro: `Appliance ${alvo.rows[0].status.toLowerCase()}: só um appliance ATIVO executa comandos.`,
          status: 409,
        };
      }

      // Um segundo clique no botão não deve virar dois restarts. A janela é a
      // fila pendente: enquanto o appliance não buscou, o pedido já está lá.
      const jaNaFila = await cliente.query(
        `SELECT id FROM appliance_commands
          WHERE appliance_id = $1 AND comando = $2
            AND status = 'PENDENTE' AND expires_at > NOW()`,
        [appliance_id, comando],
      );
      if (jaNaFila.rowCount) {
        return {
          erro: 'Este comando já está na fila deste appliance, aguardando o próximo contato.',
          status: 409,
        };
      }

      const inserido = await cliente.query(
        `INSERT INTO appliance_commands
           (appliance_id, comando, parametros, issued_by, issued_email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, comando, parametros, status, created_at, expires_at`,
        [
          appliance_id,
          comando,
          JSON.stringify(validacao.parametros ?? {}),
          sessao.id ?? null,
          sessao.email ?? null,
        ],
      );

      // Na mesma transação que a inserção, de propósito: um restart de loja
      // sem registro de quem pediu é exatamente a pergunta que a auditoria
      // existe para responder.
      await registrarAuditoria(cliente, {
        organizationId: alvo.rows[0].organization_id,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'appliance.command',
        resourceType: 'appliance',
        resourceId: appliance_id,
        detail: { comando, parametros: validacao.parametros },
        ipAddress: ipDaRequisicao(request),
      });

      return { comando: inserido.rows[0] };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }

    return NextResponse.json({ status: 'success', comando: resultado.comando });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Commands Create Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}

/** Cancela um comando que ainda não foi entregue. */
export async function DELETE(request: Request) {
  try {
    const sessao = sessaoDaRequisicao(request);
    if (!sessao || !podeAdministrar(sessao.role)) {
      return NextResponse.json({ error: 'Acesso restrito.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
    }

    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // Só PENDENTE: uma vez entregue, o appliance já está executando e
      // cancelar aqui mudaria a tela sem mudar a loja.
      const res = await cliente.query(
        `UPDATE appliance_commands
            SET status = 'CANCELADO', completed_at = NOW()
          WHERE id = $1 AND status = 'PENDENTE'
        RETURNING id, appliance_id, comando`,
        [id],
      );
      if (!res.rowCount) return null;

      const org = await cliente.query(
        `SELECT s.organization_id FROM appliances a
           JOIN stores s ON s.id = a.store_id WHERE a.id = $1`,
        [res.rows[0].appliance_id],
      );

      await registrarAuditoria(cliente, {
        organizationId: org.rows[0]?.organization_id ?? null,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'appliance.command.cancel',
        resourceType: 'appliance',
        resourceId: res.rows[0].appliance_id,
        detail: { comando: res.rows[0].comando },
        ipAddress: ipDaRequisicao(request),
      });

      return res.rows[0];
    });

    if (!resultado) {
      return NextResponse.json(
        { error: 'Comando não encontrado, ou já entregue ao appliance.' },
        { status: 404 },
      );
    }

    return NextResponse.json({ status: 'success' });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Commands Cancel Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
