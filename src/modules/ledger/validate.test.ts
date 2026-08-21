import { describe, expect, it } from "vitest";
import { AppError } from "../../http/error-handler.js";
import { parseCreateTransactionInput } from "./validate.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "key-1",
    entries: [
      { accountId: A, direction: "debit", amount: 1000 },
      { accountId: B, direction: "credit", amount: 1000 },
    ],
    ...overrides,
  };
}

describe("parseCreateTransactionInput", () => {
  it("aceita um body válido", () => {
    const result = parseCreateTransactionInput(validBody());
    expect(result.idempotencyKey).toBe("key-1");
    expect(result.entries).toHaveLength(2);
  });

  it("rejeita idempotencyKey ausente", () => {
    const body = validBody({ idempotencyKey: undefined });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita idempotencyKey vazia", () => {
    const body = validBody({ idempotencyKey: "" });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita menos de 2 entries", () => {
    const body = validBody({
      entries: [{ accountId: A, direction: "debit", amount: 1000 }],
    });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita entries que não é array", () => {
    const body = validBody({ entries: "not-an-array" });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita accountId que não é uuid", () => {
    const body = validBody({
      entries: [
        { accountId: "not-a-uuid", direction: "debit", amount: 1000 },
        { accountId: B, direction: "credit", amount: 1000 },
      ],
    });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita direction inválida", () => {
    const body = validBody({
      entries: [
        { accountId: A, direction: "sideways", amount: 1000 },
        { accountId: B, direction: "credit", amount: 1000 },
      ],
    });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita amount não inteiro", () => {
    const body = validBody({
      entries: [
        { accountId: A, direction: "debit", amount: 10.5 },
        { accountId: B, direction: "credit", amount: 1000 },
      ],
    });
    expect(() => parseCreateTransactionInput(body)).toThrow(AppError);
  });

  it("rejeita amount negativo ou zero", () => {
    const negative = validBody({
      entries: [
        { accountId: A, direction: "debit", amount: -1000 },
        { accountId: B, direction: "credit", amount: 1000 },
      ],
    });
    const zero = validBody({
      entries: [
        { accountId: A, direction: "debit", amount: 0 },
        { accountId: B, direction: "credit", amount: 1000 },
      ],
    });
    expect(() => parseCreateTransactionInput(negative)).toThrow(AppError);
    expect(() => parseCreateTransactionInput(zero)).toThrow(AppError);
  });

  it("rejeita body que não é objeto", () => {
    expect(() => parseCreateTransactionInput(null)).toThrow(AppError);
    expect(() => parseCreateTransactionInput("string")).toThrow(AppError);
  });
});
