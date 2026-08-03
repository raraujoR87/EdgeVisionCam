# VisionCam — Avaliação de maturidade

Documento de arquiteto. Onde o sistema está, o que separa isto de um SaaS de
mercado, e em que ordem atacar. Escrito para ser discordado com argumento.

---

## 1. O veredito, sem rodeio

**O núcleo está sólido. A superfície não existe.**

O que foi construído nas últimas rodadas — hierarquia de inquilinos, isolamento
imposto pelo banco, auditoria transacional, limites por plano — é a parte que
normalmente é feita errado e depois custa uma reescrita. Está certa, e foi
verificada contra o Postgres de produção.

O que está faltando é quase tudo que o cliente **vê e sente**. E aqui você tem
razão: as duas telas que entreguei são funcionais e feias, cada uma reinventando
botão, tabela e estado vazio.

A tentação agora é pintar mais telas. Seria errado, e a razão é medível.

---

## 2. O que eu medi

| Verificação | Resultado |
|---|---|
| Componentes compartilhados de UI | **Nenhum** — cada página reinventa |
| Paginação nas listagens | Só em `/api/audit`. As outras trazem tudo |
| Rate limiting | **Nenhum** |
| Envio de e-mail | **Nenhum** |
| CI roda o build | Sim — e teria pego o erro que quebrou 3 deploys |

A última linha é sobre mim: o CI estava certo, eu empurrei e reportei sucesso
sem esperar o resultado. O sinal existia.

As duas primeiras explicam por que a UI parece amadora. **Não é falta de
capricho numa tela; é ausência de sistema.** Sem componentes compartilhados,
cada página nova diverge um pouco mais, e o resultado agregado parece feito por
pessoas diferentes — porque, na prática, foi.

---

## 3. O que separa isto de um SaaS de mercado

Ranqueado por **impacto sobre a venda**, não por dificuldade.

### 3.1 Não existe onboarding — bloqueia escala comercial

Hoje, para ganhar um cliente alguém precisa: entrar como SUPER_ADMIN, criar a
organização, criar a loja, criar o usuário com uma senha que **você escolhe**, e
mandar essa senha por algum canal.

Isso não é um produto, é um serviço operado à mão. E tem um problema de
segurança embutido: **o administrador define a senha do cliente**. Todo SaaS
sério manda convite por e-mail com token de uso único justamente para que
ninguém, nem o operador, conheça a senha do usuário.

Custo: e-mail transacional + fluxo de convite. É o item de maior retorno.

### 3.2 Não há cobrança — o plano é decorativo

`organizations.plan` limita quantas lojas o cliente cria. Nada mais. Não há
assinatura, fatura, meio de pagamento, nem consequência para inadimplência além
de um botão manual de suspender.

Um SaaS sem cobrança é um piloto. Não precisa ser Stripe no dia um, mas precisa
existir a noção de ciclo, vencimento e bloqueio automático.

### 3.3 Limites não são aplicados na ingestão

`dentroDoLimite()` roda quando alguém **cria** uma loja pelo painel. Mas o
appliance envia telemetria e eventos por `x-store-api-key`, e esse caminho não
consulta limite nenhum.

Consequência concreta: um cliente em `trial` pode ligar dez appliances por fora
do painel e consumir banco e banda indefinidamente. O teto existe na tela e não
no lugar onde o custo acontece.

### 3.4 Listagens sem paginação — quebram no primeiro cliente grande

`/api/stores`, `/api/users`, `/api/organizations` trazem tudo, sempre. Com uma
rede de 200 lojas isso é uma resposta de megabytes e uma tela que trava.

Não é problema hoje porque há uma loja. É o tipo de defeito que aparece
exatamente quando o negócio começa a dar certo.

### 3.5 Nenhuma observabilidade

Não há métrica, traço nem alerta. Quando um cliente disser "o painel está
lento", a resposta disponível é abrir o log da Vercel e ler.

Um SaaS precisa responder três perguntas sem ninguém perguntar: está no ar,
está rápido, e quem está sofrendo.

### 3.6 Sem design system — a causa da aparência

Descrito acima. É o que faz cada tela nova custar caro e sair diferente.

---

## 4. O que já é bom, e por quê

Registrado para não ser refeito por engano.

**Isolamento no banco, não no código.** A diferença é o modo de falha: com
filtro em código, um `WHERE` esquecido entrega dados de outro cliente; com RLS,
devolve zero linhas. Verificado em produção — um `STORE_ADMIN` da organização A
recebe zero linhas ao consultar as lojas da B.

**Papel sem `BYPASSRLS`.** O detalhe que quase passou: a `DATABASE_URL` conecta
como `postgres`, que ignora RLS. Sem `SET LOCAL ROLE visioncam_app`, toda a
política seria decorativa — o pior resultado possível, porque parece seguro.

**Auditoria transacional.** Gravada dentro da mesma transação da ação. Fora
dela, produziria registro de coisas que não aconteceram ou ações sem registro.

**A borda decide sozinha.** A nuvem nunca está no caminho crítico de uma
detecção. A rede de uma loja cai; um antifurto que dependa dela não funciona
quando mais importa.

---

## 5. Sequência proposta

A ordem não é por dificuldade. É por **o que destrava o resto**.

### Onda 1 — parar de sangrar (1 a 2 semanas)

| # | O quê | Por que primeiro |
|---|---|---|
| 1 | **Design system**: shell, tabela, formulário, estado vazio, toast, skeleton | Toda tela depois disso sai certa e igual. Sem ele, cada uma diverge mais |
| 2 | **Paginação e busca** em todas as listagens | Barato agora, caro depois que houver dados |
| 3 | **Limites na ingestão** | O teto precisa estar onde o custo acontece |

### Onda 2 — virar produto vendável (2 a 4 semanas)

| # | O quê | Por que |
|---|---|---|
| 4 | **Convite por e-mail** com token de uso único | Remove a senha das mãos do operador e permite onboarding sem você |
| 5 | **Autoatendimento**: signup, seleção de plano, criação da primeira loja | É o que transforma demonstração em cliente |
| 6 | **Dashboard consolidado** por organização | Hoje o painel é loja-cêntrico; uma rede não tem visão de conjunto |

### Onda 3 — sustentar (contínuo)

| # | O quê |
|---|---|
| 7 | Cobrança e ciclo de assinatura |
| 8 | Observabilidade: métrica por inquilino, alerta de appliance parado |
| 9 | Exportação de dados e exclusão a pedido (LGPD) |
| 10 | API pública com chave por cliente, e webhooks de saída |

---

## 6. O que eu faria diferente do óbvio

Três opiniões, para serem contestadas.

**Não quebre em microsserviços.** É o reflexo comum quando alguém diz
"monolítico não escala". Next.js na Vercel já é serverless e escala
horizontalmente sozinho; Postgres único aguenta centenas de inquilinos. Dividir
agora adiciona operação sem remover gargalo. O gargalo real era o modelo de
dados, e ele foi corrigido.

**Não construa telas bonitas antes do design system.** Cinco telas bonitas e
divergentes são piores que cinco feias e consistentes — porque a divergência é
que não tem conserto barato.

**Meça a acurácia antes de vender acurácia.** A dívida mais séria do produto não
está na nuvem: ninguém mediu a taxa de falso alarme com dados rotulados. Um
antifurto que acusa inocente perde o cliente mais rápido do que um que deixa
passar furto. Isso exige clipes rotulados da loja — trabalho de campo, não de
código, e ninguém pode fazer por você.

---

## 7. Como provar que é bom

Afirmação sem evidência não convence comprador técnico. O que serve de prova:

| Alegação | Evidência que a sustenta |
|---|---|
| "Isolado entre clientes" | Teste de vazamento rodando **no CI**, contra Postgres real |
| "Escalável" | Números de carga: p95 com 100 lojas e 10 mil eventos |
| "Auditável" | A trilha existe, é imutável, e a tela mostra |
| "Confiável" | Uptime medido, não prometido |

Hoje temos o terceiro. O primeiro está a um workflow de distância: o teste que
rodei à mão contra o Supabase precisa virar job de CI com um Postgres em
container.

**Esse é o item que eu faria antes de qualquer tela** — é o que transforma "eu
verifiquei uma vez" em "não regride".
