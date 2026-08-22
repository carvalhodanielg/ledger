import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { createAccount, fundAccount } from "../../test/fixtures.js";

describe("POST /pix/keys", () => {
  it("registra uma chave pra uma conta existente", async () => {
    const account = await createAccount();

    const res = await request(app).post("/pix/keys").send({
      accountId: account.id,
      keyType: "email",
      keyValue: "alice@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.accountId).toBe(account.id);
    expect(res.body.keyType).toBe("email");
    expect(res.body.keyValue).toBe("alice@example.com");
  });

  it("rejeita conta inexistente", async () => {
    const res = await request(app).post("/pix/keys").send({
      accountId: "00000000-0000-0000-0000-000000000000",
      keyType: "email",
      keyValue: "ghost@example.com",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("account_not_found");
  });

  it("rejeita duas contas reivindicando a mesma chave", async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();

    const first = await request(app).post("/pix/keys").send({
      accountId: accountA.id,
      keyType: "phone",
      keyValue: "+5511999999999",
    });
    expect(first.status).toBe(201);

    const second = await request(app).post("/pix/keys").send({
      accountId: accountB.id,
      keyType: "phone",
      keyValue: "+5511999999999",
    });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("pix_key_already_in_use");
  });

  it("rejeita keyType inválido", async () => {
    const account = await createAccount();

    const res = await request(app).post("/pix/keys").send({
      accountId: account.id,
      keyType: "bitcoin",
      keyValue: "abc",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /pix/charges e GET /pix/charges/:id", () => {
  async function createPixKey() {
    const account = await createAccount();
    const res = await request(app).post("/pix/keys").send({
      accountId: account.id,
      keyType: "random",
      keyValue: crypto.randomUUID(),
    });
    return { account, pixKey: res.body };
  }

  it("gera um QR de valor fixo referenciando a chave", async () => {
    const { pixKey } = await createPixKey();

    const res = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    expect(res.status).toBe(201);
    expect(res.body.charge.amountType).toBe("fixed");
    expect(res.body.charge.amount).toBe(1500);
    expect(res.body.qrPayload).toEqual({
      txid: res.body.charge.id,
      keyType: "random",
      keyValue: pixKey.keyValue,
      amountType: "fixed",
      amount: 1500,
    });

    const get = await request(app).get(`/pix/charges/${res.body.charge.id}`);
    expect(get.status).toBe(200);
    expect(get.body.qrPayload).toEqual(res.body.qrPayload);
  });

  it("gera um QR de valor aberto, sem amount", async () => {
    const { pixKey } = await createPixKey();

    const res = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "open",
    });

    expect(res.status).toBe(201);
    expect(res.body.charge.amountType).toBe("open");
    expect(res.body.charge.amount).toBeNull();
    expect(res.body.qrPayload.amount).toBeUndefined();
  });

  it("rejeita amount junto de amountType open", async () => {
    const { pixKey } = await createPixKey();

    const res = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "open",
      amount: 100,
    });

    expect(res.status).toBe(400);
  });

  it("rejeita amountType fixed sem amount", async () => {
    const { pixKey } = await createPixKey();

    const res = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
    });

    expect(res.status).toBe(400);
  });

  it("rejeita chave inexistente", async () => {
    const res = await request(app).post("/pix/charges").send({
      pixKeyId: "00000000-0000-0000-0000-000000000000",
      amountType: "open",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("pix_key_not_found");
  });

  it("rejeita id inválido em GET /pix/charges/:id", async () => {
    const res = await request(app).get("/pix/charges/nao-uuid");
    expect(res.status).toBe(400);
  });
});

describe("POST /pix/pay", () => {
  async function createPixKeyFor(account: { id: string }) {
    const res = await request(app).post("/pix/keys").send({
      accountId: account.id,
      keyType: "random",
      keyValue: crypto.randomUUID(),
    });
    return res.body;
  }

  it("paga uma cobrança fixa, movendo o valor exato da chave", async () => {
    const payer = await createAccount();
    await fundAccount(payer.id, 5000);
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(res.status).toBe(201);
    expect(res.body.entries).toHaveLength(2);
    expect(
      res.body.entries.find((e: { accountId: string }) => e.accountId === payer.id),
    ).toMatchObject({ direction: "debit", amount: 1500 });
    expect(
      res.body.entries.find((e: { accountId: string }) => e.accountId === payee.id),
    ).toMatchObject({ direction: "credit", amount: 1500 });

    const payerBalance = await request(app).get(`/accounts/${payer.id}/balance`);
    expect(payerBalance.body.balance).toBe(3500);
    const payeeBalance = await request(app).get(`/accounts/${payee.id}/balance`);
    expect(payeeBalance.body.balance).toBe(1500);
  });

  it("paga uma cobrança aberta com o amount informado por quem paga", async () => {
    const payer = await createAccount();
    await fundAccount(payer.id, 5000);
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "open",
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
      amount: 777,
    });

    expect(res.status).toBe(201);
    expect(
      res.body.entries.find((e: { accountId: string }) => e.accountId === payee.id),
    ).toMatchObject({ direction: "credit", amount: 777 });
  });

  it("rejeita pagar cobrança aberta sem informar amount", async () => {
    const payer = await createAccount();
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "open",
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("amount_required");
  });

  it("rejeita amount que não bate com o valor de uma cobrança fixa", async () => {
    const payer = await createAccount();
    await fundAccount(payer.id, 5000);
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
      amount: 999,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("amount_does_not_match_charge");
  });

  it("rejeita pagador sem saldo suficiente", async () => {
    const payer = await createAccount();
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("insufficient_funds");
  });

  it("rejeita pagar a própria chave", async () => {
    const account = await createAccount();
    await fundAccount(account.id, 5000);
    const pixKey = await createPixKeyFor(account);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    const res = await request(app).post("/pix/pay").send({
      chargeId: charge.body.charge.id,
      payerAccountId: account.id,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("cannot_pay_own_charge");
  });

  it("é idempotente: repetir a mesma idempotencyKey não move o dinheiro duas vezes", async () => {
    const payer = await createAccount();
    await fundAccount(payer.id, 5000);
    const payee = await createAccount();
    const pixKey = await createPixKeyFor(payee);

    const charge = await request(app).post("/pix/charges").send({
      pixKeyId: pixKey.id,
      amountType: "fixed",
      amount: 1500,
    });

    const idempotencyKey = crypto.randomUUID();
    const payload = {
      chargeId: charge.body.charge.id,
      payerAccountId: payer.id,
      idempotencyKey,
    };

    const first = await request(app).post("/pix/pay").send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post("/pix/pay").send(payload);
    expect(second.status).toBe(200);
    expect(second.body.transaction.id).toBe(first.body.transaction.id);

    const payeeBalance = await request(app).get(`/accounts/${payee.id}/balance`);
    expect(payeeBalance.body.balance).toBe(1500);
  });

  it("rejeita chargeId inexistente", async () => {
    const payer = await createAccount();

    const res = await request(app).post("/pix/pay").send({
      chargeId: "00000000-0000-0000-0000-000000000000",
      payerAccountId: payer.id,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("pix_charge_not_found");
  });
});
