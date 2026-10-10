# VMS Cloud

Plataforma SaaS de análise de eventos de câmeras por IA (Gemini), **sem armazenamento de vídeo**.
A nuvem guarda o registro de cada evento, o veredito da análise e a revisão humana. O frame é
enviado ao modelo, analisado e descartado. Um teste de integração impede qualquer coluna de receber imagem.

## Módulos

| Área | Onde |
|---|---|
| Isolamento entre clientes | `db/schema.sql` (RLS) e `lib/tenant.ts` |
| Análise por IA | `lib/analise.ts` (interpretação e validação puras, cliente Gemini atrás de interface) |
| Ingestão do agente | `lib/ingestao.ts` e `app/api/ingestao/eventos` |
| Painel e BI | `lib/bi.ts` e `app/(app)/painel` |
| Triagem de eventos | `app/(app)/eventos` e `app/api/eventos/[id]` |
| Assistente | `lib/assistente.ts` e `app/(app)/assistente` |
| Equipe, convites e papéis | `app/api/equipe`, `app/api/convites` |
| Locais, câmeras e agentes | `app/api/locais`, `app/api/agentes` |
| Auditoria | `app/api/auditoria` (somente leitura, sem UPDATE nem DELETE) |
| Fornecedor (clientes e planos) | `app/api/plataforma` e `app/(app)/plataforma` |

## Subir

```bash
cp .env.example .env.local        # preencha DATABASE_URL, AUTH_SECRET e GEMINI_API_KEY
psql "$DATABASE_URL" -f db/schema.sql   # idempotente
npm install
npm run dev
```

Primeiro acesso: o fornecedor cria o cliente em **Fornecedor**, que gera um link de convite
para o administrador. Não há senha padrão.

## Contrato do agente

```
POST /api/ingestao/eventos
Authorization: Bearer vms_ag_<chave gerada em Locais e agentes>
Content-Type: application/json

{
  "camera_ref": "cam-corredor-1",      // identificador local da câmera (obrigatório)
  "camera_nome": "Corredor B",         // opcional, usado na primeira vez
  "ocorrido_em": "2026-10-10T12:00:00-03:00",  // até 24 h atrás, no máximo 5 min no futuro
  "imagem_jpeg_base64": "/9j/4AAQ...", // JPEG, até ~1,5 MB
  "metadados": { "zona": "A" }         // opcional, até 4 KB
}
```

Respostas: `202` com `{evento_id, status, veredito}` (também quando a análise falha: o motivo
fica registrado e o agente **não deve reenviar** o frame), `400` para entrada inválida,
`401` para chave inválida ou revogada, `403` para cota do plano ou organização suspensa.

## Testes

```bash
npm test                                             # unitários; integração do agente se DATABASE_URL_TESTE existir
cd .. && DATABASE_URL_TESTE=postgres://... pytest tests/integracao/test_vms_postgres.py tests/test_vms_cloud_estrutura.py
```

O teste de integração cria um banco próprio por execução, aplica o schema e tenta, como o papel
da aplicação, ver e alterar dados de outro cliente, revisar com papel insuficiente, alterar o
veredito da IA e apagar a trilha. Com a RLS desligada de propósito, 7 desses testes falham.

## Decisões e limites conhecidos

- **Sem vídeo armazenado.** Consequência direta: quem revisa um alerta vê o resumo da IA e os
  metadados, não o clipe. Decisão de produto a confirmar: liberar uma visualização temporária
  do frame, sem gravação, para a revisão humana.
- **Análise síncrona.** O agente espera a resposta do modelo (até 20 s). Escala melhor com uma
  fila; não foi feito agora.
- **Limite de tentativas em memória.** Vale por instância serverless. Limite global exige
  armazenamento compartilhado.
- **Convite sem e-mail.** O administrador copia o link e entrega. Envio automático é o próximo passo.
- **Cotas e preços de planos são exemplos** (`lib/planos.ts`), não decisão comercial.
- **O Gemini não foi chamado com dados reais** neste ciclo: não há chave configurada. A
  interpretação da resposta é testada; a chamada em si, não.
