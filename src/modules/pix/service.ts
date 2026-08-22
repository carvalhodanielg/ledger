import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { accounts, pixCharges, pixKeys } from "../../db/schema.js";
import { AppError } from "../../http/error-handler.js";
import { createTransaction } from "../ledger/service.js";
import type {
  CreatePixChargeInput,
  CreatePixKeyInput,
  PayPixChargeInput,
} from "./validate.js";

const UNIQUE_VIOLATION = "23505";

// mesmo truque de routes/service do ledger: o driver postgres.js pendura o
// erro real do Postgres em `cause`.
function postgresErrorCode(err: unknown): string | undefined {
  const cause =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : err;

  return typeof cause === "object" && cause !== null
    ? (cause as { code?: string }).code
    : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return postgresErrorCode(err) === UNIQUE_VIOLATION;
}

export async function createPixKey(input: CreatePixKeyInput) {
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, input.accountId));

  if (!account) {
    throw new AppError(404, "account_not_found", { accountId: input.accountId });
  }

  try {
    const [pixKey] = await db
      .insert(pixKeys)
      .values({
        accountId: input.accountId,
        keyType: input.keyType,
        keyValue: input.keyValue,
      })
      .returning();

    if (!pixKey) {
      throw new Error("insert de pix_key não retornou linha");
    }

    return pixKey;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Não confiamos em "checar antes de inserir" — duas requisições
      // concorrentes registrando a mesma keyValue passariam pela checagem
      // antes de qualquer uma commitar. A UNIQUE constraint é o árbitro
      // real; aqui só traduzimos pra um erro de domínio.
      throw new AppError(409, "pix_key_already_in_use", {
        keyValue: input.keyValue,
      });
    }
    throw err;
  }
}

export async function getPixKey(pixKeyId: string) {
  const [pixKey] = await db
    .select()
    .from(pixKeys)
    .where(eq(pixKeys.id, pixKeyId));

  if (!pixKey) {
    throw new AppError(404, "pix_key_not_found", { pixKeyId });
  }

  return pixKey;
}

export async function createPixCharge(input: CreatePixChargeInput) {
  const pixKey = await getPixKey(input.pixKeyId);

  const [charge] = await db
    .insert(pixCharges)
    .values({
      pixKeyId: pixKey.id,
      amountType: input.amountType,
      amount: input.amountType === "fixed" ? input.amount : null,
    })
    .returning();

  if (!charge) {
    throw new Error("insert de pix_charge não retornou linha");
  }

  return { charge, qrPayload: buildQrPayload(charge, pixKey) };
}

// O "QR code" aqui é só o payload que ele carrega, como string JSON — não é
// o padrão EMV real do Pix (o roadmap permite isso como desafio extra). O
// que importa pro motor é: `txid` pra rastrear a cobrança, a chave de
// destino, e o valor (fixo) ou a ausência dele (aberto, quem paga decide).
function buildQrPayload(
  charge: typeof pixCharges.$inferSelect,
  pixKey: typeof pixKeys.$inferSelect,
) {
  return {
    txid: charge.id,
    keyType: pixKey.keyType,
    keyValue: pixKey.keyValue,
    amountType: charge.amountType,
    amount: charge.amount ?? undefined,
  };
}

// `pay` só resolve chargeId -> pixKey -> conta destino e decide o `amount`
// (fixo já vem gravado na charge; aberto vem de quem paga) — quem decide se
// a transação é válida (saldo, balanceamento) é o motor de ledger, chamado
// aqui exatamente como qualquer outro chamador de `createTransaction`. Não
// existe lógica de débito/crédito neste arquivo.
export async function payPixCharge(input: PayPixChargeInput) {
  const { charge, qrPayload } = await getPixCharge(input.chargeId);
  const pixKey = await getPixKey(charge.pixKeyId);

  const amount = resolvePaymentAmount(charge, input.amount);

  if (pixKey.accountId === input.payerAccountId) {
    throw new AppError(422, "cannot_pay_own_charge", {
      accountId: input.payerAccountId,
    });
  }

  const result = await createTransaction({
    idempotencyKey: input.idempotencyKey,
    entries: [
      { accountId: input.payerAccountId, direction: "debit", amount },
      { accountId: pixKey.accountId, direction: "credit", amount },
    ],
    metadata: {
      type: "pix_payment",
      chargeId: charge.id,
      pixKeyId: pixKey.id,
    },
  });

  return { ...result, charge, qrPayload };
}

function resolvePaymentAmount(
  charge: typeof pixCharges.$inferSelect,
  inputAmount: number | undefined,
): number {
  if (charge.amountType === "fixed") {
    if (inputAmount !== undefined && inputAmount !== charge.amount) {
      throw new AppError(422, "amount_does_not_match_charge", {
        chargeAmount: charge.amount,
        inputAmount,
      });
    }
    return charge.amount as number;
  }

  if (inputAmount === undefined) {
    throw new AppError(
      422,
      "amount_required",
      "amount é obrigatório pra pagar uma cobrança de valor aberto",
    );
  }

  return inputAmount;
}

export async function getPixCharge(chargeId: string) {
  const [charge] = await db
    .select()
    .from(pixCharges)
    .where(eq(pixCharges.id, chargeId));

  if (!charge) {
    throw new AppError(404, "pix_charge_not_found", { chargeId });
  }

  const pixKey = await getPixKey(charge.pixKeyId);

  return { charge, qrPayload: buildQrPayload(charge, pixKey) };
}
