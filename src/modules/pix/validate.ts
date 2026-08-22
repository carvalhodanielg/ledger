import { AppError } from "../../http/error-handler.js";
import { UUID_RE } from "../ledger/validate.js";

export const PIX_KEY_TYPES = ["cpf", "cnpj", "email", "phone", "random"] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

export type CreatePixKeyInput = {
  accountId: string;
  keyType: PixKeyType;
  keyValue: string;
};

// Validação de forma (400) — não decide nada de negócio (ex: se a chave já
// está em uso é conflito de banco, não de shape).
export function parseCreatePixKeyInput(body: unknown): CreatePixKeyInput {
  if (typeof body !== "object" || body === null) {
    throw new AppError(400, "invalid_request", "body precisa ser um objeto");
  }

  const { accountId, keyType, keyValue } = body as Record<string, unknown>;

  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
    throw new AppError(400, "invalid_request", "accountId precisa ser um uuid");
  }

  if (
    typeof keyType !== "string" ||
    !PIX_KEY_TYPES.includes(keyType as PixKeyType)
  ) {
    throw new AppError(
      400,
      "invalid_request",
      `keyType precisa ser um de: ${PIX_KEY_TYPES.join(", ")}`,
    );
  }

  if (typeof keyValue !== "string" || keyValue.trim().length === 0) {
    throw new AppError(400, "invalid_request", "keyValue é obrigatório");
  }

  return { accountId, keyType: keyType as PixKeyType, keyValue };
}

export type CreatePixChargeInput = {
  pixKeyId: string;
  amountType: "fixed" | "open";
  amount?: number;
};

// QR estático (amountType "fixed") carrega o valor no próprio payload; QR
// dinâmico (amountType "open") deixa o valor pra quem paga decidir — por
// isso `amount` só é aceito (e exigido) quando "fixed", e é rejeitado
// quando "open". A constraint `pix_charges_amount_matches_type` no banco é
// a mesma regra, como segunda camada.
export function parseCreatePixChargeInput(body: unknown): CreatePixChargeInput {
  if (typeof body !== "object" || body === null) {
    throw new AppError(400, "invalid_request", "body precisa ser um objeto");
  }

  const { pixKeyId, amountType, amount } = body as Record<string, unknown>;

  if (typeof pixKeyId !== "string" || !UUID_RE.test(pixKeyId)) {
    throw new AppError(400, "invalid_request", "pixKeyId precisa ser um uuid");
  }

  if (amountType !== "fixed" && amountType !== "open") {
    throw new AppError(
      400,
      "invalid_request",
      'amountType precisa ser "fixed" ou "open"',
    );
  }

  if (amountType === "fixed") {
    if (!Number.isInteger(amount) || (amount as number) <= 0) {
      throw new AppError(
        400,
        "invalid_request",
        "amount precisa ser um inteiro positivo (centavos) quando amountType é \"fixed\"",
      );
    }
    return { pixKeyId, amountType, amount: amount as number };
  }

  if (amount !== undefined) {
    throw new AppError(
      400,
      "invalid_request",
      'amount não deve ser enviado quando amountType é "open"',
    );
  }

  return { pixKeyId, amountType };
}

export type PayPixChargeInput = {
  chargeId: string;
  payerAccountId: string;
  idempotencyKey: string;
  amount?: number;
};

// Shape apenas — se o amount bate com o esperado pra cobranças "fixed" (ou
// é exigido pra "open") é decisão de negócio, resolvida em service.ts junto
// com a própria charge.
export function parsePayPixChargeInput(body: unknown): PayPixChargeInput {
  if (typeof body !== "object" || body === null) {
    throw new AppError(400, "invalid_request", "body precisa ser um objeto");
  }

  const { chargeId, payerAccountId, idempotencyKey, amount } =
    body as Record<string, unknown>;

  if (typeof chargeId !== "string" || !UUID_RE.test(chargeId)) {
    throw new AppError(400, "invalid_request", "chargeId precisa ser um uuid");
  }

  if (typeof payerAccountId !== "string" || !UUID_RE.test(payerAccountId)) {
    throw new AppError(
      400,
      "invalid_request",
      "payerAccountId precisa ser um uuid",
    );
  }

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new AppError(400, "invalid_request", "idempotencyKey é obrigatório");
  }

  if (amount !== undefined && (!Number.isInteger(amount) || (amount as number) <= 0)) {
    throw new AppError(
      400,
      "invalid_request",
      "amount precisa ser um inteiro positivo (centavos)",
    );
  }

  if (amount === undefined) {
    return { chargeId, payerAccountId, idempotencyKey };
  }

  return { chargeId, payerAccountId, idempotencyKey, amount: amount as number };
}
