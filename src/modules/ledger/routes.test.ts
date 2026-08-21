import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { db, sql } from "../../db/client.js";
import { accounts } from "../../db/schema.js";

async function createAccount(currency = "BRL") {
  const [account] = await db
    .insert(accounts)
    .values({ type: "user", currency })
    .returning();
  if (!account) throw new Error("falha ao criar conta de teste");
  return account;
}

async function countRows(table: "transactions" | "entries") {
  const [row] = await sql<{ count: string }[]>`select count(*) from ${sql(table)}`;
  return Number(row?.count ?? 0);
}

describe("POST /transactions", () => {
  let accountA: Awaited<ReturnType<typeof createAccount>>;
  let accountB: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    accountA = await createAccount();
    accountB = await createAccount();
  });

  it("cria uma transação balanceada e persiste no banco", async () => {
    const res = await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "balanced-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 1000 },
          { accountId: accountB.id, direction: "credit", amount: 1000 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.transaction.idempotencyKey).toBe("balanced-1");
    expect(res.body.entries).toHaveLength(2);

    const persisted = await sql`
      select * from transactions where idempotency_key = 'balanced-1'
    `;
    expect(persisted).toHaveLength(1);

    const persistedEntries = await sql`
      select * from entries where transaction_id = ${persisted[0]?.id}
    `;
    expect(persistedEntries).toHaveLength(2);
  });

  it("rejeita transação desbalanceada e não deixa resíduo", async () => {
    const transactionsBefore = await countRows("transactions");
    const entriesBefore = await countRows("entries");

    const res = await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "unbalanced-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 1000 },
          { accountId: accountB.id, direction: "credit", amount: 900 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unbalanced_transaction");

    expect(await countRows("transactions")).toBe(transactionsBefore);
    expect(await countRows("entries")).toBe(entriesBefore);
  });

  it("replay da mesma idempotencyKey devolve a transação original, sem duplicar", async () => {
    const body = {
      idempotencyKey: "replay-1",
      entries: [
        { accountId: accountA.id, direction: "debit", amount: 500 },
        { accountId: accountB.id, direction: "credit", amount: 500 },
      ],
    };

    const first = await request(app).post("/transactions").send(body);
    expect(first.status).toBe(201);
    const firstId = first.body.transaction.id;

    const transactionsAfterFirst = await countRows("transactions");

    const second = await request(app).post("/transactions").send(body);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(firstId);

    expect(await countRows("transactions")).toBe(transactionsAfterFirst);
  });

  it("rejeita moedas diferentes entre as contas", async () => {
    const usdAccount = await createAccount("USD");

    const res = await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "currency-mismatch-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 1000 },
          { accountId: usdAccount.id, direction: "credit", amount: 1000 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("currency_mismatch");
  });

  it("rejeita conta inexistente", async () => {
    const res = await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "missing-account-1",
        entries: [
          {
            accountId: "00000000-0000-0000-0000-000000000000",
            direction: "debit",
            amount: 1000,
          },
          { accountId: accountB.id, direction: "credit", amount: 1000 },
        ],
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("account_not_found");
  });

  it("rejeita body malformado", async () => {
    const res = await request(app)
      .post("/transactions")
      .send({ entries: [] });

    expect(res.status).toBe(400);
  });

  it("atualiza balances em sincronia com as entries", async () => {
    await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "balances-sync-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 700 },
          { accountId: accountB.id, direction: "credit", amount: 700 },
        ],
      });

    const [entriesSum] = await sql`
      select coalesce(sum(
        case when direction = 'credit' then amount else -amount end
      ), 0) as balance
      from entries where account_id = ${accountA.id}
    `;
    const [balanceRow] = await sql`
      select current_balance from balances where account_id = ${accountA.id}
    `;

    expect(Number(balanceRow?.current_balance)).toBe(
      Number(entriesSum?.balance),
    );
  });
});

describe("GET /accounts/:id/balance", () => {
  it("bate com a soma manual das entries", async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();

    await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "balance-check-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 1200 },
          { accountId: accountB.id, direction: "credit", amount: 1200 },
        ],
      });

    const [expected] = await sql`
      select coalesce(sum(
        case when direction = 'credit' then amount else -amount end
      ), 0) as balance
      from entries where account_id = ${accountA.id}
    `;

    const res = await request(app).get(`/accounts/${accountA.id}/balance`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(Number(expected?.balance));
  });

  it("responde 404 pra conta inexistente", async () => {
    const res = await request(app).get(
      "/accounts/00000000-0000-0000-0000-000000000000/balance",
    );
    expect(res.status).toBe(404);
  });

  it("responde 400 pra id inválido", async () => {
    const res = await request(app).get("/accounts/nao-uuid/balance");
    expect(res.status).toBe(400);
  });
});

describe("GET /accounts/:id/statement", () => {
  it("acumula o saldo corrente na ordem correta", async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();

    await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "statement-1",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 1000 },
          { accountId: accountB.id, direction: "credit", amount: 1000 },
        ],
      });
    await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "statement-2",
        entries: [
          { accountId: accountA.id, direction: "debit", amount: 300 },
          { accountId: accountB.id, direction: "credit", amount: 300 },
        ],
      });
    await request(app)
      .post("/transactions")
      .send({
        idempotencyKey: "statement-3",
        entries: [
          { accountId: accountB.id, direction: "debit", amount: 150 },
          { accountId: accountA.id, direction: "credit", amount: 150 },
        ],
      });

    const res = await request(app).get(`/accounts/${accountA.id}/statement`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries.map((e: { runningBalance: number }) => e.runningBalance)).toEqual([
      -1000, -1300, -1150,
    ]);
  });
});
