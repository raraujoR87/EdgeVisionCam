import { NextResponse } from 'next/server';
import { query, isDatabaseNotConfigured } from '../db';
import { verifyToken } from '../auth/tokens';
import { gerarCodigo } from './codigo';
import {
  comInquilino,
  contextoDoToken,
  registrarAuditoria,
  ipDaRequisicao,
} from '../tenant';
import { ehSuperAdmin } from '../papeis';

/**
 * Gerência dos códigos de provisionamento — consumida pelo console de nuvem.
 *
 * Diferente de /api/provisioning/claim, que o appliance chama sem credencial,
 * tudo aqui exige sessão de administrador: emitir um código é emitir acesso à
 * chave de uma loja.
 */
export const dynamic = 'force-dynamic';

/**
 * Sessao de administrador, ou null.
 *
 * Devolve o payload em vez de um booleano: as rotas precisam do id e do e-mail
 * para registrar na auditoria quem emitiu ou revogou o codigo. Sem isso, a
 * trilha diria "um codigo foi revogado" sem dizer por quem.
 */
async function exigirAdmin(request: Request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  let payload;
  try {
    payload = verifyToken(header.slice(7).trim());
  } catch {
    console.error('[provisioning] Nao foi possivel validar o token.');
    return null;
  }
  if (!payload || !ehSuperAdmin(payload.role)) return null;
  return payload;
}

/** Lista os appliances e seu estado de provisionamento. */
export async function GET(request: Request) {
  try {
    const sessao = await exigirAdmin(request);
    if (!sessao) {
      return NextResponse.json({ error: 'Acesso restrito a administradores.' }, { status: 401 });
    }

    const res = await query(
      `SELECT a.id, a.store_id, a.status, a.target_version, a.label,
              a.created_at, a.expires_at, a.claimed_at,
              (a.edge_key IS NOT NULL AND a.edge_key <> '') AS tem_edge_key,
              s.name AS store_name,
              h.last_seen, h.inference_ms,
              -- O código só é devolvido enquanto não foi usado. Depois disso
              -- exibi-lo não ajuda ninguém e mantém um segredo vivo na tela.
              CASE WHEN a.status = 'PENDENTE' THEN a.provisioning_code ELSE NULL END AS codigo
       FROM appliances a
       JOIN stores s ON s.id = a.store_id
       LEFT JOIN hardware_status h ON h.store_id = a.store_id
       ORDER BY a.created_at DESC`
    );

    return NextResponse.json({ appliances: res.rows });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Provisioning List Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}

/** Emite um novo código para uma loja. */
export async function POST(request: Request) {
  try {
    const sessao = await exigirAdmin(request);
    if (!sessao) {
      return NextResponse.json({ error: 'Acesso restrito a administradores.' }, { status: 401 });
    }

    const { store_id, label, target_version, edge_key } = await request.json();

    if (!store_id) {
      return NextResponse.json({ error: 'store_id é obrigatório.' }, { status: 400 });
    }

    const loja = await query('SELECT id FROM stores WHERE id = $1', [store_id]);
    if (loja.rowCount === 0) {
      return NextResponse.json({ error: 'Loja não encontrada.' }, { status: 404 });
    }

    // Colisão é improvável, mas a coluna é UNIQUE e falhar aqui deixaria o
    // operador sem código por um motivo que ele não teria como entender.
    let codigo = '';
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const candidato = gerarCodigo();
      const existe = await query(
        'SELECT 1 FROM appliances WHERE provisioning_code = $1',
        [candidato]
      );
      if (existe.rowCount === 0) {
        codigo = candidato;
        break;
      }
    }
    if (!codigo) {
      return NextResponse.json({ error: 'Não foi possível gerar um código.' }, { status: 500 });
    }

    const res = await query(
      `INSERT INTO appliances (store_id, provisioning_code, label, target_version, edge_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, provisioning_code, expires_at`,
      [store_id, codigo, label || null, target_version || 'latest', edge_key || null]
    );

    // Emitir um codigo cria uma credencial que provisiona um appliance na loja.
    // Sem registro, "quem autorizou este dispositivo?" fica sem resposta.
    try {
      await comInquilino(contextoDoToken(sessao), async (cliente: any) => {
        const org = await cliente.query('SELECT organization_id FROM stores WHERE id = $1', [store_id]);
        await registrarAuditoria(cliente, {
          organizationId: org.rows[0]?.organization_id ?? null,
          userId: sessao.id,
          actorEmail: sessao.email,
          action: 'provisioning.issue',
          resourceType: 'store',
          resourceId: store_id,
          detail: { label: label || null, target_version: target_version || 'latest' },
          ipAddress: ipDaRequisicao(request),
        });
      });
    } catch (erroAuditoria) {
      // A auditoria nao pode derrubar a emissao: o codigo ja existe no banco, e
      // falhar aqui deixaria o tecnico sem codigo por um problema de log.
      console.error('[provisioning] Falha ao auditar emissao:', erroAuditoria);
    }

    return NextResponse.json({ status: 'success', appliance: res.rows[0] });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Provisioning Create Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}

/** Revoga um código ou desativa um appliance. */
export async function DELETE(request: Request) {
  try {
    const sessao = await exigirAdmin(request);
    if (!sessao) {
      return NextResponse.json({ error: 'Acesso restrito a administradores.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id é obrigatório.' }, { status: 400 });
    }

    const res = await query(
      `UPDATE appliances SET status = 'REVOGADO'
       WHERE id = $1 AND status <> 'REVOGADO'
       RETURNING id, store_id, target_version`,
      [id]
    );

    if (res.rowCount === 0) {
      return NextResponse.json({ error: 'Appliance não encontrado.' }, { status: 404 });
    }

    // Log de revogação (inline, sem tabela separada)
    console.log(`[Provisioning] Appliance ${res.rows[0].id} revogado (loja ${res.rows[0].store_id})`);

    // Revogar impede novo resgate, mas não desinstala nada: um appliance já
    // provisionado segue rodando com a chave que recebeu. Para cortar o acesso
    // de verdade é preciso rotacionar a api_key da loja.
    return NextResponse.json({
      status: 'success',
      aviso: 'Código revogado. Um appliance já provisionado continua operando — '
        + 'rotacione a api_key da loja para cortar o acesso.',
    });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json({ error: 'Banco não configurado.' }, { status: 503 });
    }
    console.error('[Provisioning Revoke Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
