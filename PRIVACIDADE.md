# Privacidade e LGPD — VisionCam

> **Este documento não é parecer jurídico.** Ele mapeia o tratamento de dados
> que o sistema realiza e separa o que o software já resolve do que exige
> decisão do negócio. Valide com advogado antes de operar comercialmente.

---

## 1. Que dado pessoal o sistema trata

| Dado | Onde nasce | Onde vive | Prazo |
|---|---|---|---|
| Vídeo de clientes | Câmera da loja | `edge/storage/events/` (appliance) | `retention_days` (padrão 30 dias) |
| Coordenadas de pose (17 pontos do corpo) | Engine de visão | Memória; não persistido | Duração do evento |
| Descrição física do suspeito | Veredicto do Gemini | `events.verdict_explanation` | Junto do evento |
| Clipe enviado à nuvem | Appliance → API | Cloudflare R2 + Postgres | Junto do evento |
| Telemetria de hardware | Appliance | `hardware_status` | Sobrescrita a cada envio |

**A estimativa de pose não gera identificação biométrica** — são coordenadas
articulares, não template facial, e o sistema não faz reconhecimento facial nem
mantém galeria de pessoas. Ainda assim, vídeo de pessoa identificável é dado
pessoal, e a descrição textual do suspeito gerada pela IA também.

---

## 2. Transferência internacional

**O clipe de vídeo é enviado ao Google (Gemini) para análise.** Isso é
transferência internacional de dado pessoal (LGPD art. 33) e precisa de base
legal própria e menção no aviso ao titular.

O caminho está em `ui/app/api/webhook/route.ts` e `core/graph/agent.py`.

Para operar sem transferência internacional, mantenha `model_source` fora de
`cloud`: a decisão local (`edge/local_agent.py`) roda inteiramente no appliance,
com custo de acurácia — é justamente o que a medição de
`evaluation/` serve para quantificar.

---

## 3. O que o software já implementa

- **Expurgo automático.** `core/retention.py` remove clipes e registros após
  `retention_days`, verificado de hora em hora. Configurável em Settings.
- **Direito de eliminação.** `DELETE /api/events/{id}` apaga evento e clipe
  (art. 18, VI).
- **Minimização na exportação.** Frames exportados não contêm texto, apenas
  geometria — decisão registrada em `PROJECT_STATUS.md`.
- **Controle de acesso.** Sessões assinadas, senha de fábrica bloqueante,
  segredos não retornados pela API.
- **Confidencialidade em trânsito.** TLS obrigatório no console de nuvem e no
  canal de gerência.

---

## 4. O que exige decisão do negócio

Nada disto é implementável em código — são escolhas com consequência jurídica.

### 4.1 Base legal (art. 7º)
A hipótese provável é **legítimo interesse** (inciso IX), que exige teste de
proporcionalidade documentado: a prevenção de perdas justifica a vigilância, e
não havia meio menos invasivo. Consentimento não funciona aqui — ninguém
consente em ser filmado ao entrar num mercado.

### 4.2 Aviso ao titular (art. 9º)
Sinalização visível na entrada e nos corredores monitorados. Modelo:

> **Ambiente monitorado por câmeras com análise automatizada de imagem**
> para prevenção de perdas. As imagens são retidas por até 30 dias e podem ser
> processadas por serviço de inteligência artificial no exterior.
> Titular de dados: [canal de contato do lojista].

### 4.3 Relatório de Impacto (art. 38)
Vigilância sistemática de espaço público de acesso coletivo, com decisão
automatizada sobre comportamento. A ANPD pode requisitar o RIPD; convém tê-lo
pronto.

### 4.4 Contrato de operador (art. 39)
O lojista é **controlador**; vocês são **operadores**. O contrato precisa
delimitar finalidade, prazo, subprocessadores (Google, Cloudflare, Supabase,
Vercel) e obrigações de segurança.

### 4.5 Revisão humana (art. 20)
O titular pode pedir revisão de decisão automatizada. **Nenhuma acusação deve
partir apenas do veredicto da IA** — o alerta é insumo para um humano decidir,
e isso precisa estar no procedimento operacional do lojista, não só na intenção.

---

## 5. Riscos abertos

| Risco | Estado |
|---|---|
| Acurácia não medida — falso positivo acusa inocente | `evaluation/` existe; **faltam os rótulos** |
| Clipes no R2 sem expurgo automático | O expurgo cobre o appliance; a nuvem **ainda não** |
| Sem trilha de auditoria de quem assistiu a cada clipe | Não implementado |
| Sem cifragem em repouso no appliance | Disco do Radxa não é cifrado |

O primeiro é o mais sério: sem saber a taxa de falso positivo, não há como
afirmar que o tratamento é proporcional — e proporcionalidade é o que sustenta
o legítimo interesse.
