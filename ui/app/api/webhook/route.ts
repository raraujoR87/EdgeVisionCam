import { NextResponse } from 'next/server';
import { query } from '../db';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { put } from '@vercel/blob';

export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get('x-store-api-key') || '';
    if (!apiKey) {
      return NextResponse.json({ error: 'Faltando cabeçalho x-store-api-key' }, { status: 401 });
    }

    // 1. Validar a loja pela API Key
    const storeRes = await query('SELECT id, name, telegram_bot_token, telegram_chat_id FROM stores WHERE api_key = $1', [apiKey]);
    if (storeRes.rowCount === 0) {
      return NextResponse.json({ error: 'Chave de API inválida' }, { status: 401 });
    }
    const store = storeRes.rows[0];

    // 2. Extrair os arquivos e metadados do form-data
    const formData = await request.formData();
    const videoFile = formData.get('video') as File | null;
    const telemetryStr = formData.get('telemetry') as string | null;

    if (!videoFile || !telemetryStr) {
      return NextResponse.json({ error: 'Campos obrigatórios ausentes: video (arquivo) e telemetry (JSON string)' }, { status: 400 });
    }

    const telemetry = JSON.parse(telemetryStr);
    const videoBuffer = Buffer.from(await videoFile.arrayBuffer());

    // 3. Salvar o vídeo no Vercel Blob (se disponível) ou usar fallback
    let videoUrl = '';
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`events/${Date.now()}_${videoFile.name}`, videoFile, { access: 'public' });
      videoUrl = blob.url;
    } else {
      videoUrl = `/storage/clips/${videoFile.name}`;
    }

    // 4. Executar a auditoria de IA com o Gemini
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return NextResponse.json({ error: 'Chave de API do Gemini não configurada no servidor' }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const dossierText = `RELATÓRIO BIOMECÂNICO E DE TRAJETÓRIA (Edge YOLO)
- ID do Personagem: ${telemetry.p_id || "N/A"}
- Nível de Risco na Borda: ${telemetry.intent_analysis?.risk_level || "desconhecido"} (Score: ${telemetry.intent_analysis?.intent_score || 0.0})
- Duração: ${telemetry.video_duration_s || 0.0} segundos
- Produtos Detectados: ${telemetry.products ? telemetry.products.join(', ') : 'Nenhum'}`;

    const prompt = `Você é o Auditor de Prevenção de Perdas sênior (Líder da Equipe SOC).
Seu objetivo é assistir a este vídeo da câmera de segurança e analisar o parecer biomecânico enviado pela borda para tomar a decisão final se ocorreu um furto/ocultação de produto ou se a ação foi inocente.

PARECER DO ANALISTA BIOMECÂNICO (Métricas de Borda):
${dossierText}

REGRAS GERAIS DE AUDITORIA (DÚVIDA RAZOÁVEL):
1. A ocultação só é confirmada se o produto for inserido sob roupas, jaquetas, bolsos de calça/casaco ou bolsas fechadas de forma a sumir de vista intencionalmente. Nesse caso, classifique como furto (is_theft = true, classification = 'FURTO_CONFIRMADO').
2. Caso o produto seja colocado em carrinhos de bebê, cestas/carrinhos da loja, ou sacolas de compras abertas, NÃO classifique como furto. Classifique como 'INOCENTADO' ou, se houver comportamento altamente anômalo de olhar ao redor/vigilância, classifique no máximo como 'SUSPEITO' (is_theft = false, classification = 'SUSPEITO').
3. Se a pessoa apenas segurou o produto, colocou no carrinho/cesta comum, colocou de volta ou organizou na prateleira/gôndola sem ocultar, classifique como inocente (is_theft = false, classification = 'INOCENTADO').
4. IGNORE pertences pessoais do próprio cliente (como celulares, carteiras, chaves ou óculos). Se a pessoa apenas manuseou o próprio telefone ou guardou um pertence pessoal, classifique imediatamente como 'INOCENTADO'.

Retorne APENAS um JSON válido seguindo a estrutura abaixo, sem marcações markdown de código ou explicações extras:
{
  "is_theft": boolean,
  "confidence": float,
  "suspect_description": "detalhes físicos e vestimentas do suspeito detectado",
  "telegram_report": "resumo direto de 2-3 frases sobre o ocorrido para o lojista",
  "products_stolen": ["lista dos produtos detectados na gôndola e ocultados"],
  "classification": "INOCENTADO|SUSPEITO|FURTO_CONFIRMADO",
  "explanation": "detalhe detalhado do porquê desta classificação com base no vídeo"
}`;

    const result = await model.generateContent([
      {
        inlineData: {
          data: videoBuffer.toString('base64'),
          mimeType: videoFile.type || 'video/mp4'
        }
      },
      prompt
    ]);

    const rawResponse = result.response.text().trim();
    // Limpar marcações de código markdown se o modelo insistir nelas
    const cleanJsonText = rawResponse.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const verdict = JSON.parse(cleanJsonText);

    // 5. Gravar o resultado no Banco de Dados Postgres central
    await query(`
      INSERT INTO events (store_id, video_url, telemetry, suspicion_score, verdict, verdict_explanation, analyzed_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
    `, [
      store.id,
      videoUrl,
      JSON.stringify(telemetry),
      verdict.is_theft ? verdict.confidence : 0.0,
      verdict.classification,
      verdict.explanation || verdict.telegram_report
    ]);

    // 6. Enviar Alerta do Telegram (se configurado na loja e classificação for suspeita/furto)
    if (store.telegram_bot_token && store.telegram_chat_id && (verdict.classification === 'FURTO_CONFIRMADO' || verdict.classification === 'SUSPEITO')) {
      const message = `🚨 <b>SUSPEITA DE FURTO DETECTADA (Nuvem)</b>\n\n` +
                      `🏪 <b>Loja:</b> ${store.name}\n` +
                      `👤 <b>Suspeito:</b> ${verdict.suspect_description}\n` +
                      `📦 <b>Itens:</b> ${verdict.products_stolen ? verdict.products_stolen.join(', ') : 'Nenhum'}\n` +
                      `📊 <b>Confiança:</b> ${(verdict.confidence * 100).toFixed(1)}%\n` +
                      `📝 <b>Relatório:</b> ${verdict.telegram_report}`;

      try {
        const tgForm = new FormData();
        tgForm.append('chat_id', store.telegram_chat_id);
        tgForm.append('caption', message);
        tgForm.append('parse_mode', 'HTML');
        tgForm.append('video', new Blob([videoBuffer]), 'alert.mp4');

        const tgResp = await fetch(`https://api.telegram.org/bot${store.telegram_bot_token}/sendVideo`, {
          method: 'POST',
          body: tgForm
        });

        if (!tgResp.ok) {
          console.error('[Telegram Cloud Error]', await tgResp.text());
        }
      } catch (tgErr) {
        console.error('[Telegram Exception]', tgErr);
      }
    }

    return NextResponse.json({ success: true, verdict });
  } catch (error: any) {
    console.error('[Webhook API Error]', error);
    return NextResponse.json({ error: 'Erro interno do servidor', details: error.message }, { status: 500 });
  }
}
