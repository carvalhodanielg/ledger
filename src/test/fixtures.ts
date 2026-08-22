import { randomUUID } from "node:crypto";
import { eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/client.js";
import { accounts, balances, entries, transactions } from "../db/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Espelha `applyBalanceDelta` de `service.ts`: UPDATE primeiro, INSERT só se
// não existir linha. Não usar `INSERT ... ON CONFLICT DO UPDATE` aqui —
// com `balances_current_balance_non_negative`, o CHECK valida o valor
// literal do INSERT especulativo antes de resolver o conflito, então um
// delta negativo falha mesmo quando a linha já existe e o resultado final
// (current_balance + delta) seria válido.
async function applyDelta(tx: Tx, accountId: string, delta: number) {
  const updated = await tx
    .update(balances)
    .set({
      currentBalance: dsql`${balances.currentBalance} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(eq(balances.accountId, accountId))
    .returning({ accountId: balances.accountId });

  if (updated.length === 0) {
    await tx.insert(balances).values({ accountId, currentBalance: delta, updatedAt: new Date() });
  }
}

export async function createAccount(currency = "BRL") {
  const [account] = await db
    .insert(accounts)
    .values({ type: "user", currency })
    .returning();
  if (!account) throw new Error("falha ao criar conta de teste");
  return account;
}

// Balanço inicial artificial da conta "house" de teste — grande o bastante
// pra nunca ser esgotado por um `fundAccount` de teste, sem entry
// correspondente. `balances_current_balance_non_negative` (Semana 3, Dias
// 3-4) barraria um saldo negativo real; isso é só bootstrap de fixture, não
// passa pelo motor de transação, então fica de fora da invariante
// "balances é sempre a soma das entries" — não há teste que reconcilie a
// conta house.
const HOUSE_SEED_BALANCE = 1_000_000_000_00;

// Fixture de teste: credita `accountId` direto no banco, debitando de uma
// conta "house" descartável — bypassa a rota HTTP (e a checagem de saldo
// insuficiente, que bloquearia a própria conta de fundo) de propósito, já
// que aqui não estamos testando o motor de transação, só preparando saldo.
export async function fundAccount(accountId: string, amount: number) {
  const [houseAccount] = await db
    .insert(accounts)
    .values({ type: "house", currency: "BRL" })
    .returning();
  if (!houseAccount) throw new Error("falha ao criar conta house de teste");

  await db
    .insert(balances)
    .values({
      accountId: houseAccount.id,
      currentBalance: HOUSE_SEED_BALANCE,
      updatedAt: new Date(),
    });

  await db.transaction(async (tx) => {
    const [seedTransaction] = await tx
      .insert(transactions)
      .values({ idempotencyKey: `seed-${randomUUID()}` })
      .returning();
    if (!seedTransaction) throw new Error("falha ao criar transação de fundo");

    const createdEntries = await tx
      .insert(entries)
      .values([
        {
          transactionId: seedTransaction.id,
          accountId: houseAccount.id,
          direction: "debit",
          amount,
        },
        {
          transactionId: seedTransaction.id,
          accountId,
          direction: "credit",
          amount,
        },
      ])
      .returning();

    for (const entry of createdEntries) {
      const delta =
        entry.direction === "credit" ? entry.amount : -entry.amount;
      await applyDelta(tx, entry.accountId, delta);
    }
  });
}
