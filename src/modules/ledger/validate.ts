import { AppError } from "../../http/error-handler.js";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntryInput = {
  accountId: string;
  direction: "debit" | "credit";
  amount: number;
};

export type CreateTransactionInput = {
  idempotencyKey: string;
  entries: EntryInput[];
  metadata?: unknown;
};

// Validação de forma (400) — não decide nada de negócio, só garante que o
// shape do body é o que o resto do código assume que é.
export function parseCreateTransactionInput(
  body: unknown,
): CreateTransactionInput {
  if (typeof body !== "object" || body === null) {
    throw new AppError(400, "invalid_request", "body precisa ser um objeto");
  }

  const { idempotencyKey, entries, metadata } = body as Record<
    string,
    unknown
  >;

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new AppError(400, "invalid_request", "idempotencyKey é obrigatório");
  }

  if (!Array.isArray(entries) || entries.length < 2) {
    throw new AppError(
      400,
      "invalid_request",
      "entries precisa ter pelo menos 2 lançamentos",
    );
  }

  const parsedEntries = entries.map((entry, index) =>
    parseEntry(entry, index),
  );

  return { idempotencyKey, entries: parsedEntries, metadata };
}

function parseEntry(entry: unknown, index: number): EntryInput {
  if (typeof entry !== "object" || entry === null) {
    throw new AppError(400, "invalid_request", `entries[${index}] inválida`);
  }

  const { accountId, direction, amount } = entry as Record<string, unknown>;

  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
    throw new AppError(
      400,
      "invalid_request",
      `entries[${index}].accountId precisa ser um uuid`,
    );
  }

  if (direction !== "debit" && direction !== "credit") {
    throw new AppError(
      400,
      "invalid_request",
      `entries[${index}].direction precisa ser "debit" ou "credit"`,
    );
  }

  if (!Number.isInteger(amount) || (amount as number) <= 0) {
    throw new AppError(
      400,
      "invalid_request",
      `entries[${index}].amount precisa ser um inteiro positivo (centavos)`,
    );
  }

  return { accountId, direction, amount: amount as number };
}
