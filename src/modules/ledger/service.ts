import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { accounts, balances, entries, transactions } from "../../db/schema.js";
import { AppError } from "../../http/error-handler.js";
import type { CreateTransactionInput } from "./validate.js";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

async function loadAccountOrThrow(accountId: string) {
  const [account] = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId));

  if (!account) {
    throw new AppError(404, "account_not_found", { accountId });
  }

  return account;
}

// Convenção de sinal do ledger: saldo = soma(credit) - soma(debit).
// Uma conta "user" cresce quando é creditada e diminui quando é debitada.
export async function getAccountBalance(accountId: string) {
  const account = await loadAccountOrThrow(accountId);

  const [row] = await db
    .select({
      balance: sql<string>`coalesce(sum(
        case when ${entries.direction} = 'credit' then ${entries.amount}
             else -${entries.amount}
        end
      ), 0)`,
    })
    .from(entries)
    .where(eq(entries.accountId, accountId));

  return {
    accountId: account.id,
    currency: account.currency,
    balance: Number(row?.balance ?? 0),
  };
}

const DEFAULT_STATEMENT_LIMIT = 50;
const MAX_STATEMENT_LIMIT = 200;

// Mesma convenção de sinal do balance, mas como saldo corrente por linha:
// SUM(...) OVER (ORDER BY ...) evita somar em loop no Node — o Postgres já
// devolve a coluna pronta. Ordena por created_at + id (desempate
// determinístico pra entries com o mesmo timestamp) e acumula do mais
// antigo pro mais novo, como o roadmap pede.
export async function getAccountStatement(
  accountId: string,
  limit = DEFAULT_STATEMENT_LIMIT,
) {
  const account = await loadAccountOrThrow(accountId);

  const rows = await db
    .select({
      id: entries.id,
      transactionId: entries.transactionId,
      direction: entries.direction,
      amount: entries.amount,
      createdAt: entries.createdAt,
      runningBalance: sql<string>`sum(
        case when ${entries.direction} = 'credit' then ${entries.amount}
             else -${entries.amount}
        end
      ) over (order by ${entries.createdAt}, ${entries.id})`,
    })
    .from(entries)
    .where(eq(entries.accountId, accountId))
    .orderBy(entries.createdAt, entries.id)
    .limit(limit);

  return {
    accountId: account.id,
    currency: account.currency,
    entries: rows.map((row) => ({
      ...row,
      runningBalance: Number(row.runningBalance),
    })),
  };
}

export async function createTransaction(input: CreateTransactionInput) {
  // replay: se a idempotencyKey já existe, devolve o resultado original sem
  // re-rodar validação de negócio. Sem isso, uma segunda chamada idêntica
  // podia ser rejeitada por saldo insuficiente mesmo já tendo sido aceita
  // da primeira vez (o primeiro débito já consumiu o saldo que o segundo
  // "veria" ao checar de novo) — replay deixaria de ser idempotente.
  const existing = await tryLoadByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    return existing;
  }

  await assertAccountsAreValid(input.entries);
  assertIsBalanced(input.entries);

  try {
    return await db.transaction(async (tx) => {
      // Trava a linha de `balances` de cada conta debitada (em ordem
      // consistente de accountId, igual `applyBalanceDeltas`, pra não
      // deadlockar contra outra transação que toque as mesmas contas) e só
      // então decide se há saldo. Diferente da versão anterior (que lia o
      // saldo FORA da transação, antes de qualquer lock existir), aqui a
      // leitura e a escrita ficam na mesma janela travada — nenhuma outra
      // transação consegue ler um saldo "stale" enquanto essa não commita.
      await assertSufficientFundsLocked(tx, input.entries);

      const [transaction] = await tx
        .insert(transactions)
        .values({
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
        })
        .returning();

      if (!transaction) {
        throw new Error("insert de transaction não retornou linha");
      }

      const createdEntries = await tx
        .insert(entries)
        .values(
          input.entries.map((entry) => ({
            transactionId: transaction.id,
            accountId: entry.accountId,
            direction: entry.direction,
            amount: entry.amount,
          })),
        )
        .returning();

      await applyBalanceDeltas(tx, createdEntries);

      return { transaction, entries: createdEntries, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return await loadByIdempotencyKey(input.idempotencyKey);
    }
    if (isCheckViolation(err)) {
      // Segunda camada (Semana 3, Dias 3-4): mesmo que o lock acima tenha
      // um bug, a constraint `balances_current_balance_non_negative` recusa
      // o COMMIT. Não temos aqui o mesmo detalhe (accountId, valores) que a
      // checagem em app dá — é justamente o preço de ser uma rede de
      // segurança que não depende do código estar certo.
      throw new AppError(422, "insufficient_funds", {
        reason: "balance_constraint_violated",
      });
    }
    throw err;
  }
}

export async function reverseTransaction(
  originalTransactionId: string,
  idempotencyKey: string,
) {
  const original = await db.query.transactions.findFirst({
    where: eq(transactions.id, originalTransactionId),
  });

  if (!original) {
    throw new AppError(404, "transaction_not_found", {
      transactionId: originalTransactionId,
    });
  }

  const originalEntries = await db.query.entries.findMany({
    where: eq(entries.transactionId, original.id),
  });

  try {
    return await db.transaction(async (tx) => {
      const [reversal] = await tx
        .insert(transactions)
        .values({
          idempotencyKey,
          reversalOfTransactionId: original.id,
          metadata: { reversalOf: original.id },
        })
        .returning();

      if (!reversal) {
        throw new Error("insert de transaction (reversão) não retornou linha");
      }

      // espelha cada entry original invertendo a direção — se a original
      // balanceava (débito = crédito), a inversão balanceia por construção,
      // não precisa reassertar.
      const mirroredEntries = await tx
        .insert(entries)
        .values(
          originalEntries.map((entry) => ({
            transactionId: reversal.id,
            accountId: entry.accountId,
            direction:
              entry.direction === "debit"
                ? ("credit" as const)
                : ("debit" as const),
            amount: entry.amount,
          })),
        )
        .returning();

      await applyBalanceDeltas(tx, mirroredEntries);

      return { transaction: reversal, entries: mirroredEntries, replayed: false };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    // duas UNIQUE constraints podem ter disparado esse erro (idempotencyKey
    // ou reversalOfTransactionId) — não confiamos em qual delas o Postgres
    // reportou primeiro, então checamos as duas hipóteses explicitamente.
    const replay = await db.query.transactions.findFirst({
      where: eq(transactions.idempotencyKey, idempotencyKey),
    });
    if (replay) {
      const replayEntries = await db.query.entries.findMany({
        where: eq(entries.transactionId, replay.id),
      });
      return { transaction: replay, entries: replayEntries, replayed: true };
    }

    const existingReversal = await db.query.transactions.findFirst({
      where: eq(transactions.reversalOfTransactionId, original.id),
    });
    if (existingReversal) {
      throw new AppError(409, "transaction_already_reversed", {
        transactionId: original.id,
        reversalTransactionId: existingReversal.id,
      });
    }

    throw err;
  }
}

// o driver (postgres.js) lança o erro real como `cause` de um
// DrizzleQueryError — o código do Postgres mora em err.cause.code.
function postgresErrorCode(err: unknown): string | undefined {
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : err;

  return typeof cause === "object" && cause !== null
    ? (cause as { code?: string }).code
    : undefined;
}

// Não confiamos em "checar antes de inserir" — duas requisições concorrentes
// com a mesma idempotencyKey passariam pela checagem antes de qualquer uma
// commitar. A UNIQUE constraint no banco é o árbitro real; aqui só reagimos
// a ela.
function isUniqueViolation(err: unknown): boolean {
  return postgresErrorCode(err) === UNIQUE_VIOLATION;
}

function isCheckViolation(err: unknown): boolean {
  return postgresErrorCode(err) === CHECK_VIOLATION;
}

async function tryLoadByIdempotencyKey(idempotencyKey: string) {
  const transaction = await db.query.transactions.findFirst({
    where: eq(transactions.idempotencyKey, idempotencyKey),
  });

  if (!transaction) {
    return undefined;
  }

  const transactionEntries = await db.query.entries.findMany({
    where: eq(entries.transactionId, transaction.id),
  });

  return { transaction, entries: transactionEntries, replayed: true };
}

async function loadByIdempotencyKey(idempotencyKey: string) {
  const existing = await tryLoadByIdempotencyKey(idempotencyKey);

  if (!existing) {
    // Não deveria acontecer: só chegamos aqui depois de um unique violation
    // nessa mesma chave.
    throw new Error("unique violation sem transação correspondente");
  }

  return existing;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Atualiza balances no MESMO commit das entries — se um cair, os dois caem.
// O UPDATE pega um lock de linha por conta, na mesma ordem sempre
// (accountId ordenado), pra evitar deadlock entre duas transações
// concorrentes que tocam as mesmas contas em ordem trocada.
//
// Não usa `INSERT ... ON CONFLICT DO UPDATE` (upsert em uma linha só) —
// pegadinha do Postgres: com `balances_current_balance_non_negative`, o
// CHECK é validado contra o valor LITERAL do `VALUES()` antes de resolver o
// conflito, mesmo quando o resultado final do `DO UPDATE` seria válido. Um
// débito de conta com saldo alto (delta negativo, resultado final
// positivo) falhava o CHECK na tentativa especulativa de INSERT, mesmo já
// existindo a linha. UPDATE primeiro evita isso: o CHECK aí valida o valor
// já somado (`current_balance + delta`), que é o que realmente importa.
async function applyBalanceDeltas(
  tx: Tx,
  createdEntries: (typeof entries.$inferSelect)[],
) {
  const deltaByAccount = new Map<string, number>();
  for (const entry of createdEntries) {
    const delta = entry.direction === "credit" ? entry.amount : -entry.amount;
    deltaByAccount.set(
      entry.accountId,
      (deltaByAccount.get(entry.accountId) ?? 0) + delta,
    );
  }

  const accountIds = [...deltaByAccount.keys()].sort();

  for (const accountId of accountIds) {
    const delta = deltaByAccount.get(accountId) as number;
    await applyBalanceDelta(tx, accountId, delta);
  }
}

async function applyBalanceDelta(tx: Tx, accountId: string, delta: number) {
  const updated = await tx
    .update(balances)
    .set({
      currentBalance: sql`${balances.currentBalance} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(eq(balances.accountId, accountId))
    .returning({ accountId: balances.accountId });

  if (updated.length === 0) {
    // primeira entry desta conta — ainda não existe linha em `balances`
    // pra atualizar. Só chega aqui com delta negativo se
    // `assertSufficientFundsLocked` tiver um bug (uma conta sem linha em
    // `balances` tem saldo implícito 0, que já rejeitaria qualquer débito
    // antes de chegar aqui) — nesse caso o CHECK constraint recusa o
    // INSERT, que é o comportamento certo mesmo sem essa garantia.
    await tx.insert(balances).values({ accountId, currentBalance: delta, updatedAt: new Date() });
  }
}

// Trava a linha de `balances` de cada conta debitada (SELECT ... FOR
// UPDATE) e só então compara com o débito pedido — leitura e decisão na
// mesma janela travada, dentro da transação que também vai gravar. Uma
// segunda transação concorrente que tente travar a mesma conta espera aqui
// até essa transação commitar ou dar rollback; não há mais janela pra ler
// um saldo desatualizado. Contas debitadas ficam ordenadas por accountId,
// mesma ordem de `applyBalanceDeltas`, pra nunca inverter a ordem de lock
// entre duas transações concorrentes que tocam as mesmas contas (deadlock).
//
// Limitação conhecida: se a conta nunca recebeu nenhuma entry, não existe
// linha em `balances` pra travar — a primeira `INSERT` (em
// `applyBalanceDeltas`) só acontece depois. Duas primeiras transações
// concorrentes debitando a mesma conta nova ainda podem colidir; na
// prática isso não importa aqui porque a constraint
// `balances_current_balance_non_negative` barra o resultado de qualquer
// jeito.
async function assertSufficientFundsLocked(
  tx: Tx,
  inputEntries: CreateTransactionInput["entries"],
) {
  const debitByAccount = new Map<string, number>();
  for (const entry of inputEntries) {
    if (entry.direction === "debit") {
      debitByAccount.set(
        entry.accountId,
        (debitByAccount.get(entry.accountId) ?? 0) + entry.amount,
      );
    }
  }

  const accountIds = [...debitByAccount.keys()].sort();

  for (const accountId of accountIds) {
    const debitAmount = debitByAccount.get(accountId) as number;

    const [row] = await tx
      .select({ balance: balances.currentBalance })
      .from(balances)
      .where(eq(balances.accountId, accountId))
      .for("update");

    const balance = row?.balance ?? 0;
    if (balance < debitAmount) {
      throw new AppError(422, "insufficient_funds", {
        accountId,
        balance,
        debitAmount,
      });
    }
  }
}

function assertIsBalanced(inputEntries: CreateTransactionInput["entries"]) {
  let debitTotal = 0;
  let creditTotal = 0;

  for (const entry of inputEntries) {
    if (entry.direction === "debit") {
      debitTotal += entry.amount;
    } else {
      creditTotal += entry.amount;
    }
  }

  if (debitTotal !== creditTotal) {
    throw new AppError(422, "unbalanced_transaction", {
      debitTotal,
      creditTotal,
    });
  }
}

async function assertAccountsAreValid(
  inputEntries: CreateTransactionInput["entries"],
) {
  const accountIds = [...new Set(inputEntries.map((e) => e.accountId))];

  const foundAccounts = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));

  if (foundAccounts.length !== accountIds.length) {
    const foundIds = new Set(foundAccounts.map((a) => a.id));
    const missing = accountIds.filter((id) => !foundIds.has(id));
    throw new AppError(404, "account_not_found", { accountIds: missing });
  }

  const currencies = new Set(foundAccounts.map((a) => a.currency));
  if (currencies.size > 1) {
    throw new AppError(422, "currency_mismatch", {
      currencies: [...currencies],
    });
  }
}
