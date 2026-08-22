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
