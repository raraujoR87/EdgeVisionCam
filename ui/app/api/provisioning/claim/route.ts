import { NextResponse } from 'next/server';
import { query, isDatabaseNotConfigured } from '../../db';
import { normalizarCodigo, codigoValido } from '../codigo';

/**
 * Resgate do código de provisionamento.
 *
 * Chamado pelo appliance, não pelo navegador — é aqui que o código curto que o
 * técnico digitou vira a configuração real da loja.
 *
 * Esta rota é intencionalmente **não autenticada**: o appliance ainda não tem
 * credencial nenhuma, e obtê-la é justamente o propósito da chamada. O que
 * protege é o próprio código: uso único, validade de 7 dias e limite de
 * tentativas. Por isso a resposta de erro nunca diz se o código existe, só que
 * não serve.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { codigo } = await request.json();

    if (!codigoValido(codigo || '')) {
      return NextResponse.json(
        { error: 'Código inválido ou expirado.' },
        { status: 400 }
      );
    }

    const normalizado = normalizarCodigo(codigo);

    const res = await query(
      `SELECT a.id, a.store_id, a.status, a.target_version, a.edge_key, a.expires_at,
              s.name AS store_name, s.api_key, s.telegram_bot_token, s.telegram_chat_id
       FROM appliances a
       JOIN stores s ON s.id = a.store_id
       WHERE a.provisioning_code = $1`,
      [normalizado]
    );

    // Mesma resposta para código inexistente, já usado, revogado e vencido:
    // distinguir os casos permitiria varrer o espaço de códigos descobrindo
    // quais existem.
    const generico = NextResponse.json(
      { error: 'Código inválido ou expirado.' },
      { status: 400 }
    );

    if (res.rowCount === 0) return generico;

    const ap = res.rows[0];
    if (ap.status !== 'PENDENTE') return generico;
    if (ap.expires_at && new Date(ap.expires_at) < new Date()) return generico;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null;

    // Queima o código antes de devolver a configuração. Se a resposta se perder
    // no caminho, o operador emite outro código — preferível a deixar um código
    // válido circulando por ter havido falha de rede.
    await query(
      `UPDATE appliances
       SET status = 'ATIVO', claimed_at = CURRENT_TIMESTAMP, claimed_ip = $2
       WHERE id = $1`,
      [ap.id, ip]
    );

    await query(
      `INSERT INTO deploy_events (appliance_id, store_id, event_type, to_version, detail)
       VALUES ($1, $2, 'PROVISIONADO', $3, $4)`,
      [ap.id, ap.store_id, ap.target_version, `Resgatado de ${ip || 'origem desconhecida'}`]
    );

    return NextResponse.json({
      status: 'success',
      store: {
        id: ap.store_id,
        name: ap.store_name,
        api_key: ap.api_key,
      },
      deploy: {
        version: ap.target_version || 'latest',
        edge_key: ap.edge_key || '',
        // Sem edge key não há gerência central; o appliance não deve subir um
        // agente pela metade.
        mgmt_mode: ap.edge_key ? 'portainer-edge-agent' : 'none',
      },
      telegram: {
        bot_token: ap.telegram_bot_token || '',
        chat_id: ap.telegram_chat_id || '',
      },
    });
  } catch (erro: any) {
    if (isDatabaseNotConfigured(erro)) {
      return NextResponse.json(
        { error: 'Banco de dados não configurado no servidor.' },
        { status: 503 }
      );
    }
    console.error('[Provisioning Claim Error]', erro);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
