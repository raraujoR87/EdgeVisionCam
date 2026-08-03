import { NextResponse } from 'next/server';
import { query } from '../db';

export const maxDuration = 15; // Configuração Vercel nativa para tempo limite


export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get('x-store-api-key') || '';
    if (!apiKey) {
      return NextResponse.json({ error: 'Faltando cabeçalho x-store-api-key' }, { status: 401 });
    }

    const body = await request.json();
    const { cpu_usage, ram_usage, npu_status } = body;
    // Opcional: appliances em versão anterior não enviam este campo.
    const inference_ms = body.inference_ms ?? null;

    if (cpu_usage === undefined || ram_usage === undefined || !npu_status) {
      return NextResponse.json({ error: 'Campos obrigatórios ausentes: cpu_usage, ram_usage, npu_status' }, { status: 400 });
    }

    // 1. Validar o appliance pela API Key
    const deviceRes = await query('SELECT id, store_id, label as name FROM appliances WHERE edge_key = $1', [apiKey]);
    
    let applianceId: number;
    let storeId: number;
    let deviceName: string;

    if (deviceRes.rowCount && deviceRes.rowCount > 0) {
      // Autenticou via Edge Key (Appliance)
      applianceId = deviceRes.rows[0].id;
      storeId = deviceRes.rows[0].store_id;
      deviceName = deviceRes.rows[0].name || 'Appliance ' + applianceId;
    } else {
      // Fallback para Stores legado (se o dispositivo usar a key da loja antiga)
      const storeRes = await query('SELECT id, name FROM stores WHERE api_key = $1', [apiKey]);
      if (!storeRes.rowCount || storeRes.rowCount === 0) {
        return NextResponse.json({ error: 'Chave de API inválida' }, { status: 401 });
      }
      
      storeId = storeRes.rows[0].id;
      // Auto-migrar: criar um appliance legado para essa loja
      // Auto-registro so ate o teto do plano: sem isto, a chave da loja
      // registra appliances sem limite, que e o caminho mais barato de burlar
      // a cobranca.
      const cabe = await query(
        `SELECT o.max_appliances,
                (SELECT COUNT(*)::int FROM appliances a2
                   JOIN stores s2 ON s2.id = a2.store_id
                  WHERE s2.organization_id = o.id) AS atuais
           FROM stores s JOIN organizations o ON o.id = s.organization_id
          WHERE s.id = $1`,
        [storeId],
      );
      if (cabe.rowCount && cabe.rows[0].atuais >= cabe.rows[0].max_appliances) {
        return NextResponse.json(
          { error: `Limite do plano atingido: ${cabe.rows[0].atuais}/${cabe.rows[0].max_appliances} appliances.` },
          { status: 402 },
        );
      }
      const newDev = await query("INSERT INTO appliances (store_id, label, edge_key, status) VALUES ($1, $2, $3, 'ATIVO') RETURNING id", [storeId, 'Appliance Legado ' + storeId, apiKey]);
      applianceId = newDev.rows[0].id;
      deviceName = 'Appliance Legado ' + storeId;
    }

    // 1b. Estado comercial da organizacao dona da loja.
    //
    // O limite do plano era verificado apenas quando alguem criava loja pelo
    // painel. Este caminho — appliance autenticando por x-store-api-key — nao
    // consultava nada, entao um cliente em trial podia ligar dez appliances por
    // fora e consumir banco e banda indefinidamente. O teto existia na tela e
    // nao no lugar onde o custo acontece.
    const comercial = await query(
      `SELECT o.id, o.status, o.max_appliances,
              (SELECT COUNT(*)::int FROM appliances a2
                 JOIN stores s2 ON s2.id = a2.store_id
                WHERE s2.organization_id = o.id) AS appliances_atuais
         FROM stores s JOIN organizations o ON o.id = s.organization_id
        WHERE s.id = $1`,
      [storeId],
    );

    if (comercial.rowCount) {
      const org = comercial.rows[0];

      // 402 e nao 403: o problema e de pagamento, nao de permissao. O appliance
      // usa o codigo para decidir se tenta de novo mais tarde ou para de vez.
      if (org.status !== 'ativa') {
        return NextResponse.json(
          { error: 'Organizacao suspensa. Regularize para retomar o envio.' },
          { status: 402 },
        );
      }

      // Conta apenas appliances ja registrados. Um que exceda o teto e recusado
      // antes de virar linha no banco — o custo e barrado na porta, nao depois.
      if (org.appliances_atuais > org.max_appliances) {
        return NextResponse.json(
          { error: `Limite do plano excedido: ${org.appliances_atuais}/${org.max_appliances} appliances.` },
          { status: 402 },
        );
      }
    }

    // 2. Inserir ou Atualizar o status do hardware (AGORA REFERENCIANDO appliance_id)
    await query(`
      INSERT INTO hardware_status (appliance_id, store_id, cpu_usage, ram_usage, npu_status, inference_ms, last_seen)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (appliance_id)
      DO UPDATE SET
        cpu_usage = EXCLUDED.cpu_usage,
        ram_usage = EXCLUDED.ram_usage,
        npu_status = EXCLUDED.npu_status,
        inference_ms = EXCLUDED.inference_ms,
        last_seen = CURRENT_TIMESTAMP
    `, [applianceId, storeId, cpu_usage, ram_usage, npu_status, inference_ms]);

    return NextResponse.json({ success: true, device: deviceName });
  } catch (error: any) {
    console.error('[Telemetry API Error]', error);
    return NextResponse.json({ error: 'Erro interno do servidor', details: error.message }, { status: 500 });
  }
}
