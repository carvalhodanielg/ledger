import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { accounts, balances, entries, transactions } from "../../db/schema.js";
import { AppError } from "../../http/error-handler.js";
import type { CreateTransactionInput } from "./validate.js";

const UNIQUE_VIOLATION = "23505";

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
  await assertAccountsAreValid(input.entries);
  assertIsBalanced(input.entries);

  try {
    return await db.transaction(async (tx) => {
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
    throw err;
  }
}

// Não confiamos em "checar antes de inserir" — duas requisições concorrentes
// com a mesma idempotencyKey passariam pela checagem antes de qualquer uma
// commitar. A UNIQUE constraint no banco é o árbitro real; aqui só reagimos
// a ela.
function isUniqueViolation(err: unknown): boolean {
  // o driver (postgres.js) lança o erro real como `cause` de um
  // DrizzleQueryError — o código do Postgres mora em err.cause.code.
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : err;

  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: string }).code === UNIQUE_VIOLATION
  );
}

async function loadByIdempotencyKey(idempotencyKey: string) {
  const transaction = await db.query.transactions.findFirst({
    where: eq(transactions.idempotencyKey, idempotencyKey),
  });

  if (!transaction) {
    // Não deveria acontecer: só chegamos aqui depois de um unique violation
    // nessa mesma chave.
    throw new Error("unique violation sem transação correspondente");
  }

  const transactionEntries = await db.query.entries.findMany({
    where: eq(entries.transactionId, transaction.id),
  });

  return { transaction, entries: transactionEntries, replayed: true };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Atualiza balances no MESMO commit das entries — se um cair, os dois caem.
// O UPDATE (via onConflictDoUpdate) pega um lock de linha por conta, na
// mesma ordem sempre (accountId ordenado), pra evitar deadlock entre duas
// transações concorrentes que tocam as mesmas contas em ordem trocada.
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
    await tx
      .insert(balances)
      .values({ accountId, currentBalance: delta, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: balances.accountId,
        set: {
          currentBalance: sql`${balances.currentBalance} + ${delta}`,
          updatedAt: new Date(),
        },
      });
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
