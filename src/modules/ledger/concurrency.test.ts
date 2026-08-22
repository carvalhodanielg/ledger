import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { sql } from "../../db/client.js";
import { createAccount, fundAccount } from "../../test/fixtures.js";

// Semana 3 do roadmap: mesmo script usado nos Dias 1-2 (reproduzir a race
// condition) e nos Dias 3-4 (provar que a proteção resolve). Não é load
// test (não medimos throughput/latência) — é um teste de correção sob um
// padrão específico de concorrência: N débitos simultâneos da mesma conta,
// cada um dentro do saldo individual, juntos acima do saldo total
// disponível.
//
// Versão original (Dias 1-2, ver decisions.md 2026-08-20): `service.ts`
// lia o saldo, decidia, e só depois gravava, em passos separados (TOCTOU) —
// esse teste ficava vermelho de forma não-determinística, com o saldo
// indo negativo em quase toda rodada. Resultado salvo em
// `scripts/concurrency-results/unprotected.json`.
//
// Versão atual (Dias 3-4): `assertSufficientFundsLocked` faz
// `SELECT ... FOR UPDATE` na linha de `balances` da conta debitada, dentro
// da mesma transação que grava — a leitura e a decisão ficam na mesma
// janela travada, então requisições concorrentes disputando a mesma conta
// passam a fila serializadas pelo Postgres, não mais em paralelo. Mais a
// constraint `balances_current_balance_non_negative` como segunda camada,
// caso o lock falhe por algum motivo. Com isso, esse teste deve ficar
// verde de forma consistente — rode `npm test` várias vezes pra comparar
// com o comportamento de antes.

const RESULTS_DIR = path.resolve(process.cwd(), "scripts/concurrency-results");

type ConcurrencyResult = {
  scenario: string;
  requestsFired: number;
  succeeded: number;
  rejected: number;
  otherStatusCodes: number[];
  finalBalanceSource: number;
  finalBalanceDestination: number;
  systemDebitTotal: number;
  systemCreditTotal: number;
  wentNegative: boolean;
};

async function getEntriesSum(accountId: string): Promise<number> {
  const [row] = await sql<{ balance: string }[]>`
    select coalesce(sum(
      case when direction = 'credit' then amount else -amount end
    ), 0) as balance
    from entries where account_id = ${accountId}
  `;
  return Number(row?.balance ?? 0);
}

// Toda transação aceita é balanceada por construção (débito == crédito), e
// isso não depende de proteção nenhuma contra concorrência — é garantido
// desde a Semana 1 (assertIsBalanced). A invariante que NUNCA deveria
// quebrar, com ou sem race condition, é: soma de todos os débitos do
// sistema == soma de todos os créditos. (O TOTAL em si cresce a cada
// transação nova — isso é esperado, não é o que estamos checando aqui.)
async function getSystemTotals(): Promise<{ debit: number; credit: number }> {
  const [row] = await sql<{ debit: string; credit: string }[]>`
    select
      coalesce(sum(amount) filter (where direction = 'debit'), 0) as debit,
      coalesce(sum(amount) filter (where direction = 'credit'), 0) as credit
    from entries
  `;
  return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) };
}

describe("concorrência — transferências simultâneas da mesma conta", () => {
  it("50 débitos concorrentes, cada um dentro do saldo individual mas juntos acima do saldo total", async () => {
    const source = await createAccount();
    const destination = await createAccount();

    const INITIAL_BALANCE = 100_000; // R$1000,00 em centavos
    const REQUEST_COUNT = 50;
    const DEBIT_AMOUNT = 3_000; // R$30,00 — sozinho cabe; 50x (R$1500) não cabe

    await fundAccount(source.id, INITIAL_BALANCE);

    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, (_, i) =>
        request(app)
          .post("/transactions")
          .send({
            idempotencyKey: `race-${i}`,
            entries: [
              { accountId: source.id, direction: "debit", amount: DEBIT_AMOUNT },
              { accountId: destination.id, direction: "credit", amount: DEBIT_AMOUNT },
            ],
          }),
      ),
    );

    const succeeded = responses.filter((r) => r.status === 201).length;
    const rejected = responses.filter((r) => r.status === 422).length;
    const otherStatusCodes = responses
      .filter((r) => r.status !== 201 && r.status !== 422)
      .map((r) => r.status);

    const finalBalanceSource = await getEntriesSum(source.id);
    const finalBalanceDestination = await getEntriesSum(destination.id);
    const systemTotals = await getSystemTotals();

    const result: ConcurrencyResult = {
      scenario: "for-update-plus-check-constraint",
      requestsFired: REQUEST_COUNT,
      succeeded,
      rejected,
      otherStatusCodes,
      finalBalanceSource,
      finalBalanceDestination,
      systemDebitTotal: systemTotals.debit,
      systemCreditTotal: systemTotals.credit,
      wentNegative: finalBalanceSource < 0,
    };

    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      path.join(RESULTS_DIR, "protected.json"),
      JSON.stringify(result, null, 2),
    );

    console.log("[concorrência/protected]", result);

    expect(otherStatusCodes).toEqual([]);

    // Vale sempre, com ou sem proteção: toda transação aceita é balanceada
    // (débito == crédito), então a soma total de débitos do sistema sempre
    // bate com a soma total de créditos.
    expect(systemTotals.debit).toBe(systemTotals.credit);

    // A propriedade que o `FOR UPDATE` + constraint agora garantem de
    // verdade — diferente da versão ingênua, isso deve valer em toda
    // rodada, não só às vezes.
    expect(finalBalanceSource).toBeGreaterThanOrEqual(0);
  });
});

// Semana 3, Dia 5: os testes existentes de idempotência (routes.test.ts)
// provam o caso sequencial — a segunda chamada só é disparada depois que a
// primeira já commitou. Isso não exercita a race real: duas requisições com
// a mesma idempotencyKey chegando ao mesmo tempo passam as duas pelo
// `tryLoadByIdempotencyKey` ANTES de qualquer uma commitar (nenhuma vê a
// outra ainda), então as duas tentam o INSERT. A garantia de "só uma vez"
// não pode vir dessa checagem — tem que vir da UNIQUE constraint no banco e
// do catch em `createTransaction` que devolve a transação já commitada pra
// quem perdeu a corrida (service.ts, `isUniqueViolation`).
describe("concorrência — idempotencyKey repetida", () => {
  it("N requisições simultâneas com a mesma idempotencyKey criam a transação uma única vez", async () => {
    const source = await createAccount();
    const destination = await createAccount();

    const INITIAL_BALANCE = 100_000;
    const REQUEST_COUNT = 20;
    const AMOUNT = 3_000;
    const idempotencyKey = "idempotency-race-key";

    await fundAccount(source.id, INITIAL_BALANCE);

    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        request(app)
          .post("/transactions")
          .send({
            idempotencyKey,
            entries: [
              { accountId: source.id, direction: "debit", amount: AMOUNT },
              { accountId: destination.id, direction: "credit", amount: AMOUNT },
            ],
          }),
      ),
    );

    // 201 pra quem "ganhou" a corrida (criou de fato), 200 pra quem colidiu
    // na UNIQUE constraint e recebeu o replay — nunca outra coisa.
    const otherStatusCodes = responses
      .filter((r) => r.status !== 201 && r.status !== 200)
      .map((r) => r.status);
    expect(otherStatusCodes).toEqual([]);
    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 200).length).toBe(
      REQUEST_COUNT - 1,
    );

    // Todas as respostas devem apontar pra exatamente a mesma transação —
    // não pra N transações diferentes que por acaso deram certo.
    const transactionIds = new Set(responses.map((r) => r.body.transaction.id));
    expect(transactionIds.size).toBe(1);

    const [{ count: transactionCount }] = await sql<{ count: string }[]>`
      select count(*) as count from transactions where idempotency_key = ${idempotencyKey}
    `;
    expect(Number(transactionCount)).toBe(1);

    const [{ count: entryCount }] = await sql<{ count: string }[]>`
      select count(*) as count from entries e
      join transactions t on t.id = e.transaction_id
      where t.idempotency_key = ${idempotencyKey}
    `;
    expect(Number(entryCount)).toBe(2);

    const finalBalanceSource = await getEntriesSum(source.id);
    expect(finalBalanceSource).toBe(INITIAL_BALANCE - AMOUNT);
  });
});
