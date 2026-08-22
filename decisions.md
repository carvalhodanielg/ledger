# Decisions

## 2026-08-20 — Framework HTTP: Express

Escolhido Express em vez de Fastify ou `node:http` puro.

**Trade-off:** Fastify traria validação de schema JSON nativa (útil pra
rejeitar entries desbalanceadas antes de chegar na lógica de domínio) e é
mais rápido. `node:http` puro seria zero dependência e mais alinhado com a
filosofia de "não esconder nada" do projeto, mas o boilerplate de roteamento
e parsing de JSON não ensina nada sobre o domínio do ledger.

Express venceu por ser o padrão mais difundido, com zero mágica sobre o
request/response — a validação de balanceamento (o que realmente importa
aqui) fica na camada de domínio, não no framework, então o ganho do Fastify
nesse ponto não se aplica.

## 2026-08-20 — Estrutura de pastas

```
src/
  db/
    client.ts     # conexão Drizzle + Postgres, único lugar que lê DATABASE_URL
    schema.ts     # tabelas (já existente)
  http/
    error-handler.ts  # AppError + middleware central de erro
  modules/
    ledger/
      routes.ts   # rotas do motor contábil (fase 1-2)
    pix/          # futuro — fase 3, só vai chamar o módulo ledger
  app.ts          # monta express + middlewares + rotas
  index.ts        # só faz app.listen
```

Separação em `modules/` por domínio (ledger, pix) em vez de por camada
técnica (controllers/, services/) — reforça o princípio do CLAUDE.md de que
a camada de Pix não deve ter lógica financeira própria: ela vai importar do
módulo `ledger`, nunca duplicar sua lógica.

`index.ts` fica fino de propósito (só `listen`) pra permitir testar `app`
diretamente com supertest sem precisar subir uma porta de verdade.

## 2026-08-20 — Erros de domínio viram `AppError`

Erros que a API precisa traduzir em status HTTP (ex: transação
desbalanceada, saldo insuficiente) são lançados como `AppError(status,
message, details)` e capturados por um error handler central do Express.
Isso mantém a camada de domínio sem nenhum conhecimento de HTTP — ela só
lança um erro tipado, quem decide o código HTTP é a borda da API.

## 2026-08-20 — `--env-file` em vez de `dotenv`

Node 20.6+ suporta `--env-file` nativamente. Evita depender do pacote
`dotenv` só pra carregar uma variável (`DATABASE_URL`). Scripts `dev` e
`start` no `package.json` passam `--env-file=.env` explicitamente.

## 2026-08-20 — `idempotencyKey` é gerado pelo cliente

O servidor nunca gera essa chave — só a exige e a valida (400 se ausente,
via unique constraint pra detectar reenvio).

**Por quê:** idempotência existe pra proteger contra o cliente reenviar a
mesma requisição (timeout, retry de rede, double-click) sem saber se a
primeira chamada teve sucesso. Se o servidor gerasse a chave, cada retry
geraria uma chave nova e a proteção não serviria pra nada — o valor só faz
sentido se representa "a mesma intenção" através de múltiplas tentativas, e
só quem sabe disso é quem está reenviando.

## 2026-08-20 — `POST /transactions` exige as entries explícitas, não infere a contrapartida

O cliente envia o array `entries` completo (débito e crédito), o endpoint
não aceita "só o débito" com o servidor inferindo o crédito correspondente
(ou vice-versa).

**Por quê:** pra inferir a contrapartida, o servidor ainda precisaria saber
a conta de destino — ou seja, o cliente mandaria o mesmo dado só que
reembalado como `{ fromAccountId, toAccountId, amount }`. Esse shape
assume que toda transação é uma transferência de A pra B com exatamente 2
pontas e 1 valor, o que quebra no primeiro caso de N pontas (ex: Pix com
taxa — pagador, recebedor, conta de taxa, na mesma transação). Também
vazaria lógica de produto ("dado X, quais são as entries?") pro motor
genérico, que deve continuar sem saber o que é "transferência" ou
"pagamento" — só sabe validar que débitos = créditos.

**Onde a conveniência entra:** não no motor, mas na camada de produto.
Endpoints como `POST /pix/pay { from, to, amount }` (Semana 4) constroem o
array `entries` internamente e chamam `createTransaction` — o cliente da
API Pix não pensa em partida dobrada, mas o motor da Semana 1 continua
genérico e explícito.

## 2026-08-20 — Crash entre o insert de `transaction` e o de `entries`

Os dois inserts (`transaction` e `entries`) ficam dentro do mesmo
`db.transaction(...)`, que segura uma única conexão/`BEGIN` no Postgres
durante todo o callback.

**O que acontece se o processo Node morrer nesse meio-tempo:** o socket
com o Postgres cai, e o Postgres faz rollback automático de qualquer
transação de banco não commitada nessa conexão — comportamento padrão
dele, não algo que a aplicação precisa programar. Resultado: nem a
`transaction` nem as `entries` existem no banco; nada fica "meio salvo".

**Por que isso não quebra idempotência:** o cliente não recebeu resposta
(processo morreu antes de responder) e vai fazer retry com a mesma
`idempotencyKey`. Como nada foi commitado, a `UNIQUE` constraint não
bloqueia o retry — ele cria a transação do zero, normal.

**Caso mais sutil:** crash **depois** do `COMMIT` mas **antes** da
resposta HTTP chegar no cliente. O cliente também faz retry, mas agora a
`UNIQUE` constraint pega a chave já existente e o `catch` em
`service.ts` devolve a transação original com `200` — sem duplicar.

Atomicidade da transação de banco (o que fica salvo se o processo morre no
meio) e idempotência do cliente (o que acontece quando ele tenta de novo)
são a mesma garantia vista de dois ângulos. Se os inserts fossem comandos
separados sem `db.transaction`, o crash no meio deixaria uma `transaction`
órfã sem `entries` — exatamente o cenário que a Semana 1 do roadmap pede
pra provar que não acontece.

## 2026-08-20 — `GET /accounts/:id/balance`: convenção de sinal e cálculo direto de `entries`

**Convenção:** `balance = soma(credit) - soma(debit)`. Uma conta cresce
quando é creditada e diminui quando é debitada. Fica documentada em
comentário no código porque é fácil inverter sem perceber, e toda leitura
de saldo/extrato depende dela.

**Cálculo:** agregação SQL direto em `entries` (`SUM(CASE WHEN direction =
'credit' ...)`), não a tabela `balances`. `entries` é a fonte da verdade;
`balances` fica reservada pra Semana 5 (reconciliação), quando existe um
job que garante que ela nunca diverge silenciosamente do que as `entries`
dizem. Calcular direto agora evita introduzir uma segunda fonte de verdade
antes de ter o mecanismo que a mantém honesta.

## 2026-08-20 — `GET /accounts/:id/statement`: saldo corrente e paginação

**Saldo corrente via window function** —
`SUM(...) OVER (ORDER BY created_at, id)` no Postgres, mesma convenção de
sinal do balance. Evita somar em loop no Node; o banco já devolve a coluna
pronta.

**Ordem cronológica crescente (mais antiga primeiro), desempatando por
`id`** — é o que faz o saldo corrente por linha fazer sentido como
acumulado de cima pra baixo (critério de "pronto" do roadmap). O desempate
por `id` existe porque duas entries da mesma transação podem ter o mesmo
`created_at`; sem uma ordem determinística, a window function poderia
devolver acumulados diferentes entre execuções.

**Paginação via `limit`** (default 50, teto 200, valida como inteiro) —
sem isso, uma conta com milhões de entries devolveria resposta ilimitada,
o cenário que o próprio roadmap usa como motivação da tabela `balances`.

Testado manualmente: 3 entries em sequência (-1000, -300, +150) produziram
`runningBalance` -1000 → -1300 → -1150, e o último bate exatamente com o
resultado de `GET /accounts/:id/balance` pra mesma conta.

## 2026-08-20 — `balances` atualiza de forma síncrona, no mesmo commit das entries

`applyBalanceDeltas` roda dentro do mesmo `db.transaction` que insere
`transaction` + `entries` em `createTransaction`. Pra cada conta tocada,
faz um upsert (`insert ... on conflict do update`) que soma o delta
(`+amount` se credit, `-amount` se debit) ao `current_balance` existente,
ou cria a linha com esse delta se a conta ainda não tinha uma.

**Trade-off contra atualização assíncrona:** um job/worker que recalcula
`balances` depois do commit não bloquearia o caminho de escrita principal,
mas criaria uma janela onde `entries` já tem a verdade e `balances` ainda
não sabe — se o processo morresse nessa janela, a divergência ficaria até
algo recalcular. Síncrono garante que `entries` e `balances` sempre
commitam juntos ou nenhum dos dois commita (mesma atomicidade que já
protege `transaction` + `entries`).

**Ordem determinística de lock:** quando uma transação toca múltiplas
contas (ex: A débito, B crédito), os `accountId` são ordenados antes do
upsert. Sem isso, duas transações concorrentes tocando as mesmas contas em
ordem trocada (uma faz A depois B, a outra faz B depois A) podem se
deadlockar — cada uma segurando o lock que a outra espera. Ordenar
sempre pela mesma chave elimina esse ciclo.

**Efeito colateral observado no teste manual:** contas que já tinham
`entries` de transações criadas *antes* dessa mudança mostraram `balances`
divergente da soma real — porque `balances` só captura deltas a partir de
quando essa lógica passou a existir, não o histórico anterior. Não é bug:
é o motivo pelo qual a Semana 5 (reconciliação) existe — qualquer divergência
entre `balances` e a soma de `entries` deve ser detectável e, nesse caso
específico, corrigível com um backfill pontual. Testado com contas novas
(sem histórico): `balances` bateu exatamente com a soma de `entries` e com
`GET /accounts/:id/balance` após duas transações em sequência.

## 2026-08-20 — `applyBalanceDeltas`: upsert atômico via `onConflictDoUpdate`

**Por que agregar deltas por conta num `Map` antes de escrever:** uma
transação pode ter duas (ou mais) entries na mesma conta — nada no schema
proíbe. Se eu fizesse um `UPDATE balances` por entry em vez de por conta,
teria N statements competindo pelo lock da mesma linha dentro da própria
transação, sem necessidade. Acumulando os deltas primeiro, cada conta
sofre exatamente um `UPDATE`/upsert por transação.

**Por que `sql\`${balances.currentBalance} + ${delta}\`` em vez de
ler-somar-escrever em JS:** ler o valor atual, somar em JavaScript e
escrever de volta é uma race condition clássica — se outra transação
escrever no meio dessas duas viagens ao banco, o segundo `UPDATE`
sobrescreve com um valor já desatualizado. Fazer `current_balance + delta`
dentro do próprio `UPDATE` SQL é atômico: leitura e escrita acontecem na
mesma operação, sob o lock que o `UPDATE` já segura. É a mesma ideia de
`UPDATE contas SET saldo = saldo + 10` — nunca `SET saldo = <valor lido
antes>`.

**Por que `onConflictDoUpdate` (upsert) em vez de checar-existe-antes:**
uma conta pode não ter linha em `balances` ainda (primeira transação
dela). Em vez de `SELECT` pra decidir entre `INSERT` e `UPDATE`,
`INSERT ... ON CONFLICT (account_id) DO UPDATE` resolve os dois casos num
único statement atômico — sem essa checagem antes, que teria a mesma race
condition do parágrafo anterior (duas transações concorrentes na mesma
conta nova, ambas veem "não existe", ambas tentam `INSERT`, uma falha por
unique violation em vez de simplesmente somar).

**Por que ordenar `accountIds` antes do loop de upsert:** evita deadlock.

Exemplo concreto: duas transações de banco concorrentes tocando as mesmas
duas contas, em ordem trocada.

```
Transação A (conta-1 → conta-2):
  upsert balances(conta-1)   -- pega lock em conta-1
  upsert balances(conta-2)   -- pega lock em conta-2

Transação B (conta-2 → conta-1):
  upsert balances(conta-2)   -- pega lock em conta-2
  upsert balances(conta-1)   -- pega lock em conta-1
```

Sem ordenação, no pior caso de intercalação:

```
t0  A pega lock(conta-1)
t1  B pega lock(conta-2)
t2  A tenta pegar lock(conta-2) → espera, porque B está com ele
t3  B tenta pegar lock(conta-1) → espera, porque A está com ele
```

A está esperando um lock que só B pode liberar; B está esperando um lock
que só A pode liberar. Nenhuma libera nada porque liberar só acontece no
fim da transação (`COMMIT`/`ROLLBACK`), e nenhuma consegue chegar lá —
cada uma está travada no meio do próprio `UPDATE`. É um ciclo de espera
sem saída: deadlock.

O Postgres tem um detector de deadlock que percebe esse ciclo (roda
periodicamente) e mata uma das duas transações à força, com erro
`deadlock detected` (SQLSTATE `40P01`), pra destravar a outra. O banco não
trava pra sempre, mas uma das duas requisições do usuário falha sem motivo
aparente — um erro que só aparece sob concorrência específica, difícil de
reproduzir, o tipo de bug caro de caçar em produção.

**Com a ordenação** (`accountIds.sort()`), as duas transações — não
importa se o negócio é "1→2" ou "2→1" — sempre pedem os locks na ordem
`conta-1`, depois `conta-2`:

```
t0  A pega lock(conta-1)
t1  B tenta pegar lock(conta-1) → espera (fila, não deadlock)
t2  A pega lock(conta-2), termina, libera os dois locks (commit)
t3  B finalmente pega lock(conta-1), depois lock(conta-2), termina
```

B só espera — não há ciclo, porque as duas nunca disputam os locks em
direções opostas. Ordenar sempre pela mesma chave (aqui, `accountId`
alfabético) é a técnica padrão pra eliminar deadlock por ordem de lock
trocada: garante que todo mundo pede recursos compartilhados na mesma
sequência.

## 2026-08-20 — Suíte de testes: vitest + TRUNCATE entre testes + banco `ledger_test` dedicado

**vitest em vez de `node:test` nativo:** `node:test` evitaria mais uma
dependência (mesma lógica que levou a preferir `--env-file` do Node em vez
de `dotenv`), mas vitest tem watch mode com re-run automático por arquivo
mudado, mensagens de assertion mais legíveis, e integra sem fricção com
`tsx`/ESM do jeito que o projeto já está montado. Como a suíte vai crescer
bastante nas próximas semanas (concorrência, Pix, reconciliação), a
melhor DX de vitest pesou mais que economizar uma dependência aqui — ao
contrário do caso do `--env-file`, que trocava uma dependência por *zero*
ganho de produtividade.

**TRUNCATE entre testes em vez de rollback de transação:**
`createTransaction` (em `service.ts`) já abre sua própria `db.transaction`
internamente. Se o isolamento entre testes também fosse via transação com
`ROLLBACK`, o código sob teste precisaria rodar *dentro* dessa transação
externa — o que exigiria mudar `service.ts` pra aceitar a conexão/`tx`
como parâmetro em vez de importar `db` global, só para acomodar teste.
`TRUNCATE TABLE ... RESTART IDENTITY CASCADE` no `beforeEach` (em
`src/test/setup.ts`) resolve o isolamento sem tocar no código de produção:
cada teste começa com as quatro tabelas vazias, usando o `db`/`sql`
exportados normalmente por `src/db/client.ts`. Custo: um pouco mais lento
que rollback, e os testes de integração rodam sequenciais
(`fileParallelism: false` no `vitest.config.ts`), já que compartilham o
mesmo banco e um `TRUNCATE` no meio de outro teste corromperia o
resultado. Pra suíte desse tamanho isso não importa na prática (~2s pra
21 testes).

**Banco `ledger_test` dedicado, no mesmo container do `docker-compose.yml`:**
não um serviço Postgres separado — só outro banco lógico na mesma
instância que já sobe com `docker compose up -d`. `scripts/setup-test-db.ts`
roda como `pretest` (o `npm` chama automaticamente antes de `test`,
sem passo manual): conecta no banco `postgres` (não dá pra `DROP` o banco
em que a própria conexão está), faz `DROP DATABASE IF EXISTS ledger_test
WITH (FORCE)` seguido de `CREATE DATABASE`, e aplica a migration atual
(`drizzle/0000_overjoyed_skaar.sql`) direto. Recriar do zero a cada rodada
— em vez de só reusar um banco de teste já existente — evita o schema de
teste ficar desatualizado em relação a `drizzle/` depois de mudanças no
`src/db/schema.ts`. `.env.test` (committado, sem segredo — mesmas
credenciais fixas do `docker-compose.yml`) aponta `DATABASE_URL` pra esse
banco; `npm test` carrega esse arquivo com `--env-file`, mesma técnica já
usada em `dev`/`start`.

**Efeito colateral corrigido:** o `tsconfig.json` não tinha `include`, e o
`rootDir: "src"` fazia o `tsc` padrão (`npm run build`) falhar em
qualquer `.ts` fora de `src/` capturado pelo include implícito
(`drizzle.config.ts`, e agora também `scripts/setup-test-db.ts` e
`vitest.config.ts`). Adicionado `"include": ["src"]` — escopa o build
pro que `rootDir`/`outDir` já pressupunham, e resolve de quebra o erro
pré-existente do `drizzle.config.ts`.

## 2026-08-20 — Reversão de transação: `POST /transactions/:id/reverse`

**Contrato:** `POST /transactions/:id/reverse` com `{ idempotencyKey }` no
body — reversão também muda dinheiro, então exige idempotency key como
qualquer outra operação financeira do sistema.

**Como a transação espelhada é montada:** carrega as `entries` da
transação original e inverte `direction` de cada uma (debit↔credit),
mantendo `accountId` e `amount`. Não reassert `assertIsBalanced` nas
entries espelhadas — se a original balanceava (débito = crédito por
definição, garantido na criação), a inversão balanceia por construção
matemática; validar de novo seria checar algo que não pode dar errado.

**Impedir reverter duas vezes — decisão de schema, não só de código:**
adicionada a coluna `reversal_of_transaction_id` em `transactions`,
auto-referenciando `transactions.id`, com `UNIQUE INDEX`. Ela vive na
transação **nova** (a reversão), nunca é escrita na original — preserva
100% a imutabilidade (`entries`/`transactions` originais nunca são
tocadas). A garantia "no máximo uma reversão por transação" vem do banco,
não de uma checagem em aplicação (mesma filosofia do
`transactions_idempotency_key_idx`): checar-antes-de-inserir teria a
mesma race condition de duas requisições concorrentes passando pela
checagem antes de qualquer uma commitar.

**Detalhe não-óbvio da constraint:** a coluna é nullable (a maioria das
transações não é reversão de nada) e o Postgres trata `NULL` como "não
igual a nada" em `UNIQUE` — múltiplas linhas com
`reversal_of_transaction_id = NULL` não colidem entre si. Só duas linhas
com o mesmo valor não-nulo violam a constraint.

**Desambiguação no catch do unique violation:** o insert da reversão pode
colidir em DUAS constraints diferentes — `idempotency_key` (retry do
mesmo request) ou `reversal_of_transaction_id` (tentativa genuína de
reverter algo já revertido, com uma idempotencyKey nova). Não confiamos em
qual das duas o Postgres reporta primeiro (não é determinístico do ponto
de vista da aplicação), então o catch checa as duas hipóteses
explicitamente, nessa ordem: (1) existe uma transação com essa
`idempotencyKey`? Se sim, é replay — devolve ela com `200`. (2) Senão,
existe uma reversão já registrada pra essa transação original? Se sim, é
uma tentativa de reverter duas vezes — `409 transaction_already_reversed`,
com o id da reversão existente no corpo, pra o cliente poder consultá-la.

**Decisão deliberadamente não tomada — reverter uma reversão:** o sistema
não impede reverter a transação de reversão em si (isso "desfaz o
desfazer" e volta o saldo ao estado antes da reversão original). Não há
pedido do roadmap pra bloquear isso, e tecnicamente é uma operação válida
de partida dobrada — bloquear seria adicionar regra de negócio não pedida.
Testado manualmente: reverter a reversão devolveu o saldo exatamente ao
estado da transação original.

**Bug encontrado e corrigido durante o teste manual:** `scripts/setup-test-db.ts`
(criado pelo subagente da suíte de testes) tinha o nome da migration
`0000_overjoyed_skaar.sql` hardcoded, em vez de aplicar todos os arquivos
de `drizzle/` em ordem. A migration nova (`0001_certain_sersi.sql`, que
adiciona `reversal_of_transaction_id`) nunca rodava no banco de teste,
fazendo 4 dos 21 testes falharem com "column ... does not exist". Corrigido
pra listar e aplicar todo `.sql` de `drizzle/` ordenado por nome — o mesmo
problema voltaria a acontecer a cada nova migration se não fosse corrigido
na raiz.

Testado manualmente: criar transação (saldo -1000/+1000) → reverter
(saldo volta a 0, entries espelhadas com direção invertida) → tentar
reverter de novo com idempotencyKey diferente (409) → repetir a mesma
chamada de reversão com a mesma idempotencyKey (200, mesma transação,
sem duplicar) → transação inexistente (404) → body sem idempotencyKey
(400).

## 2026-08-21 — Testes de `POST /transactions/:id/reverse`

7 testes de integração novos em `routes.test.ts`, mesmo padrão dos
existentes (supertest contra `app`, banco `ledger_test` real): cria a
reversão e zera o saldo das duas contas; entries espelhadas com direção
invertida; segunda tentativa de reverter com `idempotencyKey` diferente
→ 409 `transaction_already_reversed` (com o id da reversão existente no
corpo); replay com a mesma `idempotencyKey` → 200, sem criar linha nova
(conferido via `countRows`); reverter a própria reversão → permitido,
saldo volta ao estado da transação original; transação inexistente → 404;
id inválido → 400; body sem `idempotencyKey` → 400.

Suíte total: 28 testes passando.

## 2026-08-20 — Semana 3, Dias 1-2: checagem de saldo ingênua + script de concorrência

**Contexto:** antes desta mudança, `createTransaction` não tinha nenhuma
checagem de saldo — só validava débito == crédito dentro da própria
transação. Uma conta podia ficar arbitrariamente negativa com uma única
chamada sequencial, sem precisar de concorrência nenhuma. Pra Semana 3 do
roadmap fazer sentido (demonstrar que concorrência quebra uma checagem que
funcionaria sequencialmente), era preciso primeiro existir uma regra de
"saldo suficiente" pra quebrar.

**Decisão:** adicionada `assertSufficientFunds` em `service.ts`, ingênua e
propositalmente sem proteção: lê o saldo (`getAccountBalance`, que soma
`entries`), decide, e só depois grava — em passos separados (TOCTOU:
time-of-check-to-time-of-use). Rejeita com `422 insufficient_funds`. Essa
falta de proteção é intencional — é o objeto que o script de concorrência
da Semana 3 Dias 3-4 vai substituir por `SELECT ... FOR UPDATE` ou
constraint de banco.

**Bug descoberto ao escrever os testes:** a checagem de saldo rodava em
toda chamada de `createTransaction`, inclusive replays de
`idempotencyKey` repetida. Isso quebrava idempotência genuína: se a
primeira chamada consumia o saldo todo, a segunda chamada (mesma
`idempotencyKey`, deveria só devolver o resultado já commitado) era
rejeitada por saldo insuficiente antes mesmo de chegar no
`try`/`catch` que trata o unique violation. Corrigido movendo a checagem de
replay (`tryLoadByIdempotencyKey`) pro topo da função, antes de qualquer
validação de negócio — replay nunca deveria re-rodar regra nenhuma, só
devolver o que já existe.

**Testes existentes quebrados pela checagem nova:** quase toda a suíte de
`routes.test.ts` debitava contas recém-criadas (saldo zero) sem fundá-las
antes. Criado helper `fundAccount` em `src/test/fixtures.ts` (extraído
junto com `createAccount`, compartilhado entre `routes.test.ts` e
`concurrency.test.ts`) que credita a conta direto no banco via uma conta
`house` descartável, bypassando a rota HTTP — decisão deliberada, porque
fundar a conta *através* da API entraria na mesma checagem de saldo
insuficiente (a conta `house` também começaria em zero). Os testes que
tinham valores de saldo hardcoded (`0`, `-1000` etc.) foram recalculados
pra refletir o saldo fundado.

**Script de concorrência** (`src/modules/ledger/concurrency.test.ts`):
dispara 50 débitos concorrentes (`Promise.all`) da mesma conta, cada um de
R$30 — individualmente cabe num saldo de R$1000, mas 50x (R$1500) excede.
Não usa ferramenta de load test externa — é um teste de integração normal
(Vitest, supertest contra `app`, banco `ledger_test` real), com asserts
direto no banco (`entries`), não nas respostas HTTP. Emite o resultado como
JSON estruturado em `scripts/concurrency-results/unprotected.json`
(requisições disparadas, aceitas, rejeitadas, saldo final de cada conta,
soma de débitos/créditos do sistema) — vira a metade "antes" do gráfico
comparativo da Semana 5.

Duas propriedades checadas, com naturezas bem diferentes:
- `systemDebitTotal === systemCreditTotal` — vale SEMPRE, com ou sem
  proteção, porque toda transação aceita é balanceada por construção
  (`assertIsBalanced`, desde a Semana 1). Não é o que a Semana 3 testa.
- `finalBalanceSource >= 0` — a propriedade real sob teste. Roda
  vermelha (comportamento esperado agora): em rodadas observadas, saldo
  final ficou entre -38000 e -50000 centavos, com 46-50 das 50
  requisições aceitas (não-determinístico, número muda a cada rodada,
  exatamente como o roadmap antecipa). Fica assim até a Semana 3 Dias 3-4
  trocar `assertSufficientFunds` por lock ou constraint — nesse momento o
  mesmo teste (só o `scenario` no JSON muda) deve ficar verde de forma
  consistente.

Suíte total: 32 testes (31 passando, 1 vermelho por design —
`concurrency.test.ts`).

## 2026-08-21 — Semana 3, Dias 3-4: `SELECT ... FOR UPDATE` + constraint de banco

**Decisão:** as duas camadas, não uma ou outra.

1. **Lock de aplicação:** `assertSufficientFunds` virou
   `assertSufficientFundsLocked`, movida pra dentro da mesma
   `db.transaction` de `createTransaction`. Faz `SELECT current_balance
   FROM balances WHERE account_id = X FOR UPDATE` pra cada conta debitada
   (ordenado por `accountId`, mesma ordem de `applyBalanceDeltas`, pra não
   inverter a ordem de lock entre duas transações concorrentes tocando as
   mesmas contas — deadlock). Leitura e decisão ficam na mesma janela
   travada: uma segunda transação tentando debitar a mesma conta espera
   até essa transação commitar ou dar rollback, não lê mais um saldo
   desatualizado.
2. **Constraint de banco:** `CHECK (current_balance >= 0)` em
   `balances.current_balance` (migration `0002_amused_angel.sql`) — rede de
   segurança que não depende do lock em (1) estar certo.

**Bug de produção descoberto ao testar a constraint:** `applyBalanceDeltas`
usava `INSERT ... ON CONFLICT (account_id) DO UPDATE` como upsert. Isso
QUEBROU com o `CHECK` novo — pegadinha não-óbvia do Postgres: em
`ON CONFLICT DO UPDATE`, o `CHECK` é validado contra o valor **literal** do
`VALUES()` durante a tentativa especulativa de INSERT, **antes** de resolver
se é conflito. Um débito de conta com saldo alto (`delta` negativo, mas
`current_balance + delta` final positivo) falhava o `CHECK` na tentativa de
inserir o `delta` bruto como se fosse linha nova — mesmo já existindo a
linha e o resultado final sendo válido. Reproduzido isolado (script
descartável fora do commit) antes de mexer no código: com uma linha de
`balances` já existente com saldo grande, `INSERT (delta=-2000) ON CONFLICT
DO UPDATE SET current_balance = current_balance + delta` falhava com
`23514 check_violation`, não com o UPDATE bem-sucedido esperado.

**Correção:** trocado o padrão upsert por UPDATE-primeiro,
INSERT-só-se-não-existir (`applyBalanceDelta` em `service.ts`, espelhada
em `applyDelta` de `src/test/fixtures.ts`, usada por `fundAccount`). O
`CHECK` agora valida o valor já somado (`current_balance + delta`) no
`UPDATE`, que é o que importa — o `INSERT` só acontece pra conta sem linha
ainda em `balances`, e só é alcançado com delta negativo se
`assertSufficientFundsLocked` tiver um bug (conta sem linha tem saldo
implícito 0, que já rejeitaria qualquer débito antes de chegar aqui).

**`fundAccount` (fixture de teste) também teve que mudar:** a conta
`house` usada pra fundar contas de teste é debitada (delta negativo) pra
creditar a conta-alvo. Antes da constraint, isso não importava; depois,
precisou de um saldo inicial artificial grande
(`HOUSE_SEED_BALANCE = 1_000_000_000_00`) escrito direto, fora do motor de
transação — documentado no código como bypass deliberado, sem
correspondência em entries pra essa conta (não há teste que reconcilie a
conta house contra suas entries).

**Resultado do script de concorrência** (`concurrency.test.ts`, mesmo
arquivo dos Dias 1-2, resultado agora salvo em
`scripts/concurrency-results/protected.json`, mantendo
`unprotected.json` como evidência do "antes"): rodado 6+ vezes seguidas,
sempre com o mesmo resultado — 33 das 50 requisições aceitas, 17
rejeitadas com `422 insufficient_funds`, saldo final da conta de origem
R$1000,00 - 33×R$30,00 = R$10,00 (nunca negativo). Determinístico agora,
ao contrário do "antes" (que variava entre 46-50 aceitas por rodada) —
esperado: o lock serializa as 50 requisições concorrentes numa fila, então
sempre processa na mesma ordem relativa e sempre para no mesmo ponto.

Suíte total: 32 testes passando (o antes vermelho-por-design agora fica
verde de forma consistente).

## 2026-08-22 — Semana 3, Dia 5: idempotência sob concorrência real

**Lacuna que os testes existentes deixavam:** `routes.test.ts` já provava
idempotência, mas só de forma sequencial — a segunda chamada só disparava
depois que a primeira já tinha commitado. Isso não exercita a race de
verdade: duas requisições com a mesma `idempotencyKey` chegando ao mesmo
tempo passam AMBAS por `tryLoadByIdempotencyKey` antes de qualquer uma
commitar (nenhuma vê a outra ainda), então as duas tentam o `INSERT`. A
garantia de "só uma vez" não pode vir dessa checagem — só pode vir da
`UNIQUE` constraint no banco e do `catch`/`isUniqueViolation` em
`createTransaction` (`service.ts`), que devolve a transação já commitada
pra quem perde a corrida.

**Teste novo** (`concurrency.test.ts`, mesmo arquivo e padrão do teste de
saldo — `Promise.all`, supertest contra `app`, banco real): 20 requisições
`POST /transactions` simultâneas, todas com a mesma `idempotencyKey`.
Asserts: exatamente 1 resposta `201` (quem ganhou a corrida e criou de
fato) e as outras 19 `200` (replay); todas as respostas apontam pro mesmo
`transaction.id`; exatamente 1 linha em `transactions` com essa chave;
exatamente 2 `entries` associadas a ela (débito + crédito, não 40); saldo
final da conta de origem reflete um único débito, não vinte.

Rodado 3+ vezes seguidas, sempre com o mesmo resultado — determinístico,
como esperado de uma garantia que vem de constraint de banco, não de
checagem em aplicação.

Suíte total: 32 testes passando. Fecha a Semana 3 do roadmap por completo
(Dias 1-2 reproduzir, 3-4 proteger contra saldo negativo, 5 idempotência
sob concorrência).

## 2026-08-22 — Semana 4, Dias 1-2: chaves Pix e QR code

**Chave Pix é única globalmente, não por conta nem por tipo.** Modelada
como `UNIQUE` em `pix_keys.key_value` sozinho (não um índice composto com
`account_id` ou `key_type`). É assim que Pix funciona de verdade: uma
chave aponta pra exatamente uma conta em todo o sistema — se duas contas
pudessem reivindicar o mesmo valor, pagar nela seria ambíguo. A rota
`POST /pix/keys` não faz "checar se existe, depois inserir": deixa o
`INSERT` ir e traduz a violação da UNIQUE constraint (`23505`) em `409
pix_key_already_in_use`, mesmo princípio já usado pra `idempotency_key`
em `transactions` — duas requisições concorrentes registrando a mesma
chave não podem confiar numa checagem prévia.

**QR code é modelado como entidade persistida (`pix_charges`), não como
payload efêmero gerado na hora.** Alternativa descartada: calcular o JSON
do QR só em memória a partir de `pixKeyId` + `amount`, sem gravar nada.
Isso bastaria pro critério de pronto de "gerar um QR referenciando uma
chave" (Dias 1-2), mas quebraria o que vem depois: `pay` (Dias 3-4)
precisa resolver um QR escaneado de volta pra uma cobrança específica por
`txid`, e cobrança de valor aberto só faz sentido se existir um registro
que sobrevive entre "gerar o QR" e "alguém pagar" (não dá pra recalcular
um payload que já foi entregue a quem vai pagar). `pix_charges.id` dobra
como o `txid` do payload.

**QR estático (`amountType: "fixed"`) vs dinâmico (`amountType: "open"`)
muda o que existe no payload, não a validação de quem paga (isso é
trabalho de Dias 3-4).** `amount` é obrigatório e `> 0` quando `fixed`
(valor fechado, quem escaneia não escolhe); é sempre `NULL` quando `open`
(quem paga decide o valor no momento de pagar). Validação em duas camadas,
mesmo padrão do resto do projeto: `validate.ts` rejeita a combinação errada
com 400 antes de tocar o banco, e a constraint `pix_charges_amount_matches_type`
recusa o mesmo caso a nível de banco, independente do código da aplicação
estar certo.

**O módulo `pix` não decide nada financeiro — só resolve chave → conta e
monta/decodifica o payload do QR.** Nenhuma entry, nenhuma transaction,
nenhum saldo é tocado em `src/modules/pix/*`. `createPixCharge` e
`getPixCharge` leem `pix_keys`/`pix_charges` e devolvem o payload; a
lógica de pagamento (Dias 3-4) vai chamar `createTransaction` do módulo
`ledger`, nunca reimplementar débito/crédito aqui — reforça o princípio do
CLAUDE.md.

Suíte total: 42 testes passando (10 novos cobrindo `POST /pix/keys`,
`POST /pix/charges`, `GET /pix/charges/:id`).

## 2026-08-22 — Semana 4, Dias 3-4: `POST /pix/pay`

**`pay` resolve `chargeId` → `pixKey` → conta destino e decide o `amount`,
e chama `createTransaction` do módulo `ledger` — não escreve nenhum
`insert` em `entries`/`balances`.** Duas entries: débito na conta de quem
paga, crédito na conta dona da chave. Saldo insuficiente, contas
inexistentes e balanceamento continuam sendo responsabilidade exclusiva do
motor de ledger; o módulo pix só traduz. `idempotencyKey` do payload de
pay é a mesma usada pelo motor — repetir a chamada com a mesma chave
devolve a transação já criada (`replayed: true`, HTTP 200), sem mover
dinheiro de novo, herdado de graça de `createTransaction`.

**`amount` é resolvido a partir do tipo da cobrança, não aceito cru do
payer.** Cobrança `fixed`: usa `charge.amount`; se o payer mandar um
`amount` diferente, `422 amount_does_not_match_charge` (mandar o mesmo
valor é aceito, é redundante mas não incoerente). Cobrança `open`: exige
`amount` no payload (`422 amount_required` se ausente) — é o payer quem
decide quanto pagar numa cobrança de valor em aberto, por definição.

**Pagar a própria chave é rejeitado (`422 cannot_pay_own_charge`).** Sem
essa checagem, `createTransaction` receberia duas entries na mesma conta
(débito e crédito de mesmo valor) — tecnicamente balanceado, mas sem
sentido de produto (transferência de uma conta pra ela mesma) e sem
handling explícito de "mesma conta duas vezes numa transação" no motor de
ledger. Melhor recusar aqui, na camada de tradução, do que deixar o motor
decidir algo que não é da conta dele.

**Decisão consciente de escopo: `pix_charges` não tem campo de status
(ex: `paid`), então nada impede pagar a mesma cobrança mais de uma vez com
`idempotencyKey`s diferentes.** Isso replica como QR estático de boleto
funciona em produção de verdade (controle de pagamento único fica em outra
camada, não no QR em si) e o roadmap não pede rastrear estado da cobrança
— só que `pay` chame o motor certo e gere as entries certas. Se isso virar
requisito, é uma coluna nova em `pix_charges` mais uma checagem em
`payPixCharge`, sem tocar no motor de ledger.

Suíte total: 50 testes passando (8 novos cobrindo `POST /pix/pay`: fixa,
aberta, amount divergente, amount ausente, saldo insuficiente, pagar a
própria chave, idempotência, charge inexistente).
