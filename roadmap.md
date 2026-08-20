# Roadmap — Ledger com partida dobrada + simulador de Pix

Ritmo assumido: 1-2h/dia útil. Cada semana tem um objetivo, perguntas para
responder sozinho antes de codar, e um critério de pronto verificável.
Não é uma receita de código — é um guia de descoberta. Trave numa pergunta?
Tente por conta própria antes de pesquisar a resposta pronta.

---

## Semana 1 — Modelagem e o motor de balanço

**Entrega da semana:** endpoint `POST /transactions` que cria uma transação
com N entries e recusa qualquer coisa desbalanceada, com garantia de
atomicidade real.

### Dias 1-2 — Schema

Desenhe `accounts`, `transactions`, `entries` antes de escrever qualquer rota.

**Descubra:**
- Por que `amount` deve ser sempre positivo, com o sinal vindo de uma coluna
  `direction`, e não um número que pode ser negativo? O que isso evita?
- Dinheiro será representado como inteiro em centavos. Prove pra si mesmo,
  com um exemplo de soma que não fecha, por que `float` é uma escolha ruim
  aqui — não aceite isso como regra decorada.
- `entries.account_id` referencia `accounts`. O que impede alguém de inserir
  uma entry apontando pra uma conta que não existe, ou de moeda
  incompatível? Isso é constraint de banco, validação de aplicação, ou os
  dois?
- Pesquise `CHECK constraint` do Postgres. Dá pra forçar `amount > 0` direto
  no schema?

**Pronto quando:** as três tabelas estão migradas, com foreign keys e
constraints que impedem os casos absurdos óbvios (amount negativo,
direction inválida).

### Dias 3-5 — O endpoint de transação

**Descubra:**
- Onde valida-se que soma de débitos = soma de créditos — antes do INSERT,
  ou como constraint que rejeita o commit? Qual é mais confiável contra bug
  futuro no seu próprio código?
- Se você faz N `INSERT` (um por entry) e o terceiro falha, o que acontece
  com os dois primeiros? Pesquise transação de banco
  (`BEGIN`/`COMMIT`/`ROLLBACK`) — é diferente do conceito de "transaction"
  do seu domínio, e você precisa saber diferenciar os dois quando fala qual.
- O que o endpoint devolve quando a transação é rejeitada por
  desbalanceamento — 400? 422? O que o corpo da resposta deveria dizer pra
  quem chamou entender o erro?

**Pronto quando:** você consegue criar uma transação válida (débito =
crédito) e vê-la persistida, **e** consegue provar que uma transação
desbalanceada não deixa nenhum resíduo no banco — nem as entries corretas
ficam meio-gravadas.

---

## Semana 2 — Saldo, extrato e reversão

**Entrega da semana:** `GET /accounts/:id/balance`, `GET
/accounts/:id/statement`, e reversão de transação — sem nunca editar ou
deletar um registro histórico.

### Dias 1-2 — Saldo como projeção

**Descubra:**
- Se saldo é sempre `soma de créditos - soma de débitos` (decida a
  convenção e documente qual), o que acontece com a performance dessa
  consulta quando uma conta tem 2 milhões de entries?
- É aí que entra a ideia de tabela `balances` como cache. Se ela é só um
  cache, quando ela é atualizada — no mesmo commit da transação, ou depois,
  de forma assíncrona? Quais os riscos de cada escolha?

**Pronto quando:** o saldo bate com a soma manual das entries (rode a query
de soma direto no `psql` e compare com o que a API devolve).

### Dias 3-4 — Extrato

**Descubra:**
- Extrato precisa mostrar saldo corrente em cada linha, não só a lista de
  movimentos. Isso é uma soma acumulada (running total) — como fazer isso
  eficientemente numa query SQL, em vez de somar em loop no Node?
- Pesquise window functions do Postgres (`SUM() OVER (ORDER BY ...)`).

**Pronto quando:** você olha o extrato de uma conta com 5+ transações e o
saldo corrente de cada linha bate com o cálculo manual, somando de cima pra
baixo.

### Dia 5 — Reversão

**Descubra:**
- Por que a reversão deve criar uma transação *nova*, espelhada, em vez de
  apagar ou editar a original? O que se perde de auditabilidade editando?
- O que acontece se alguém tentar reverter uma transação já revertida duas
  vezes? O sistema precisa impedir isso — como?

**Pronto quando:** você reverte uma transação e o saldo das contas
envolvidas volta exatamente ao estado anterior, e a transação original
continua intacta no histórico.

---

## Semana 3 — Concorrência (o núcleo do projeto)

**Entrega da semana:** um script que dispara 1000 transferências
concorrentes e prova, com números, que nada vaza nem duplica.

### Dias 1-2 — Reproduzir o problema antes de resolver

Não implemente proteção nenhuma ainda. Escreva o script de concorrência
primeiro e rode contra o que você já tem.

**Descubra:**
- Dispare 50 transferências simultâneas saindo da mesma conta, cada uma
  dentro do saldo individual, mas juntas ultrapassando o saldo total
  disponível. O que acontece? A conta fica negativa?
- Rode de novo. O resultado é sempre igual? O que isso diz sobre a natureza
  de uma race condition — ela é determinística?

**Pronto quando:** você tem, documentado (print ou log salvo), um caso
reproduzível de saldo ficando incorreto sob concorrência. É o objeto de
comparação do antes/depois no README.

### Dias 3-4 — Escolher e implementar uma proteção

**Descubra:**
- Pesquise `SELECT ... FOR UPDATE`. O que exatamente ele trava, e por
  quanto tempo? O que acontece com a segunda transação que tenta pegar o
  mesmo lock — ela erra ou espera?
- Alternativa: uma constraint de banco que impede saldo negativo
  diretamente. Mais robusta que checagem em aplicação porque não depende do
  seu código Node estar certo — mas como expressar "saldo não pode ficar
  negativo" como constraint, se saldo não é uma coluna e sim uma soma?
- Qual das duas abordagens você escolhe, e por quê? Não existe resposta
  errada — existe trade-off que você precisa saber articular.

**Pronto quando:** o mesmo script de 1000 transferências concorrentes,
contra o cenário que quebrava antes, agora não quebra mais — nenhuma conta
negativa, soma total do sistema preservada.

### Dia 5 — Idempotência

**Descubra:**
- Onde a `idempotency_key` deve ser verificada — antes de começar a criar a
  transação, ou como parte da mesma constraint/transação de banco que
  grava? O que acontece se duas requisições com a mesma chave chegarem no
  mesmo milissegundo?
- O que a API deve devolver na segunda chamada com chave repetida — o mesmo
  resultado da primeira, um erro, ou algo diferente?

**Pronto quando:** disparar a mesma requisição de transferência duas vezes
(mesma idempotency key) produz o efeito uma única vez, mesmo se as duas
chamadas forem simultâneas.

---

## Semana 4 — Pix por cima

**Entrega da semana:** chaves, QR code, pagamento e estorno, todos
delegando pro motor das semanas 1-3, sem reimplementar lógica financeira.

### Dias 1-2 — Chaves e QR code

**Descubra:**
- Uma chave Pix aponta pra uma conta. O que impede duas contas de
  reivindicarem a mesma chave?
- QR code estático de valor fixo versus valor em aberto — o que muda no
  payload e na validação no momento do pagamento?

**Pronto quando:** você gera um QR (pode ser um JSON ou string simples —
não precisa ser o padrão EMV real, a menos que queira o desafio extra)
referenciando uma chave existente.

### Dias 3-4 — Pagamento

**Descubra:**
- `pay` deveria criar a transação chamando a *mesma* função da semana 1, ou
  você está tentado a escrever lógica financeira nova aqui? Resista — o
  ponto do design é que essa camada só traduz, não decide.
- Onde entra a taxa, se decidir modelar uma? É uma terceira entry na mesma
  transação (débito extra do pagador, crédito pra uma conta de taxa) — o
  que significa que uma transação Pix pode ter mais de 2 entries. Isso
  quebra alguma suposição da semana 1?

**Pronto quando:** um pagamento Pix simulado gera exatamente as entries
certas nas contas certas, verificável pelo extrato de ambas as contas.

### Dia 5 — Estorno

**Pronto quando:** você usa a reversão da semana 2 pra desfazer um
pagamento Pix e o saldo volta ao normal — sem escrever nenhuma lógica nova
de reversão específica pra Pix.

---

## Semana 5 — Reconciliação, testes e o material que vende o projeto

**Entrega da semana:** o projeto pronto pra ser mostrado — reconciliação,
testes, README com evidência.

### Dias 1-2 — Reconciliação

**Descubra:**
- Escreva um job que recalcula o saldo de cada conta somando as entries do
  zero e compara com a tabela `balances` (o cache). O que ele faz quando
  encontra divergência — só loga, ou corrige automaticamente? Qual é mais
  seguro num sistema financeiro real?

**Pronto quando:** rodar a reconciliação num banco saudável reporta zero
divergências, e você consegue provocar uma divergência de propósito
(editando o cache manualmente) e ver o job detectar.

### Dias 3-4 — Testes

Cubra pelo menos: criação de transação balanceada e desbalanceada,
reversão, o cenário de concorrência da semana 3 como teste automatizado
(não só script manual), idempotência.

### Dia 5 — README e evidência

O que precisa estar lá:
- Diagrama simples do schema
- Seção de decisões e trade-offs (lock pessimista vs constraint, por que
  Postgres e não Mongo, por que centavos como inteiro)
- O antes/depois do teste de concorrência, com números: "sem proteção, X de
  Y execuções resultaram em saldo negativo; com a proteção implementada, 0
  de 1000"

**Pronto quando:** alguém de fora consegue clonar o repo, rodar `docker
compose up`, rodar o script de concorrência, e ver o resultado com os
próprios olhos.

---

## Se o tempo apertar

Corte a **semana 4 inteira (Pix)** antes de cortar qualquer coisa da
semana 3. O motor de partida dobrada com concorrência provada é o projeto —
o Pix é só a casca que dá contexto de produto. Um ledger sem Pix ainda é um
portfólio forte; um ledger sem o teste de concorrência é só um CRUD com
nome bonito.

---

## Stack sugerida

Node + TypeScript, Postgres (é onde `FOR UPDATE` e transações ACID
importam de verdade — não trocar por Mongo aqui), um ORM fino ou query
builder que não esconda o SQL (Knex ou Drizzle; Prisma funciona mas
abstrai demais a parte que se quer aprender). Para o script de
concorrência, `Promise.all` disparando N requisições basta.