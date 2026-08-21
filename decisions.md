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
