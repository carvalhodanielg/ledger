import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

export const accountTypeEnum = pgEnum("account_type", [
  "user",
  "house",
  "fee",
  "suspense",
]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: accountTypeEnum("type").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "posted",
  "reversed",
]);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: transactionStatusEnum("status").notNull().default("posted"),
    // descrição livre de produto (ex: { type: "pix_payment", pixKey: "..." }).
    // nunca guardar aqui algo do qual a lógica financeira dependa.
    metadata: jsonb("metadata"),
    // presente só em transações de reversão, apontando pra transação
    // original. NUNCA setado/editado na original — a imutabilidade é
    // preservada porque só a transação nova sabe que é uma reversão.
    reversalOfTransactionId: uuid("reversal_of_transaction_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("transactions_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    // NULL não colide com NULL numa unique index do Postgres — só barra
    // duas linhas com o MESMO reversal_of_transaction_id não-nulo, ou seja,
    // no máximo uma reversão por transação original.
    uniqueIndex("transactions_reversal_of_unique_idx").on(
      table.reversalOfTransactionId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------

export const entryDirectionEnum = pgEnum("entry_direction", [
  "debit",
  "credit",
]);

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    direction: entryDirectionEnum("direction").notNull(),
    // sempre positivo, em centavos. o sinal vem de `direction`, nunca do número.
    amount: bigint("amount", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("entries_amount_positive", sql`${table.amount} > 0`),
    // toda leitura de saldo/extrato filtra por account_id + ordena por tempo —
    // sem esse índice o Postgres varre a tabela inteira.
    index("entries_account_id_created_at_idx").on(
      table.accountId,
      table.createdAt,
    ),
    index("entries_transaction_id_idx").on(table.transactionId),
  ],
);

// ---------------------------------------------------------------------------
// balances — projeção/cache, NUNCA fonte de verdade.
// Recalculável a qualquer momento como SUM(credit) - SUM(debit) das entries
// daquela conta. Se este valor e a soma das entries divergirem, é bug — e é
// exatamente esse recálculo que vira a rotina de reconciliação da Semana 5.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pix_keys — camada de tradução (Semana 4). Não guarda saldo nem lógica
// financeira, só o apelido que resolve pra uma conta do motor de ledger.
// ---------------------------------------------------------------------------

export const pixKeyTypeEnum = pgEnum("pix_key_type", [
  "cpf",
  "cnpj",
  "email",
  "phone",
  "random",
]);

export const pixKeys = pgTable(
  "pix_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    keyType: pixKeyTypeEnum("key_type").notNull(),
    // valor bruto da chave (cpf, email, etc). Único GLOBALMENTE, não só por
    // conta ou por tipo — é assim que Pix funciona de verdade: uma chave
    // aponta pra exatamente uma conta em todo o sistema, senão pagar nela
    // seria ambíguo.
    keyValue: text("key_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("pix_keys_key_value_idx").on(table.keyValue),
    index("pix_keys_account_id_idx").on(table.accountId),
  ],
);

// ---------------------------------------------------------------------------
// pix_charges — a "cobrança" por trás de um QR code. Guarda só o suficiente
// pra reconstruir o payload do QR e, na Semana 4 Dias 3-4, resolver o
// pagamento de volta pra uma pix_key (e portanto uma conta). Nunca guarda
// nada que decida saldo — isso é 100% do motor de transactions/entries.
// ---------------------------------------------------------------------------

export const pixChargeAmountTypeEnum = pgEnum("pix_charge_amount_type", [
  "fixed",
  "open",
]);

export const pixCharges = pgTable(
  "pix_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pixKeyId: uuid("pix_key_id")
      .notNull()
      .references(() => pixKeys.id, { onDelete: "restrict" }),
    amountType: pixChargeAmountTypeEnum("amount_type").notNull(),
    // presente apenas em cobranças "fixed" — QR estático de valor fechado.
    // NULL em "open" — QR de valor em aberto, quem paga decide quanto.
    amount: bigint("amount", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "pix_charges_amount_matches_type",
      sql`(${table.amountType} = 'fixed' and ${table.amount} > 0) or (${table.amountType} = 'open' and ${table.amount} is null)`,
    ),
  ],
);

export const balances = pgTable(
  "balances",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "restrict" }),
    // mesma unidade e mesmo risco de overflow que entries.amount — bigint.
    currentBalance: bigint("current_balance", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Segunda camada de proteção contra saldo negativo (Semana 3, Dias
    // 3-4) — independente do `SELECT ... FOR UPDATE` em `createTransaction`
    // estar certo. `balances` não é fonte de verdade, mas É atualizada no
    // MESMO commit das entries (applyBalanceDeltas), então essa constraint
    // barra o COMMIT de qualquer caminho de código (presente ou futuro) que
    // deixe a soma das entries de uma conta ir negativa.
    check("balances_current_balance_non_negative", sql`${table.currentBalance} >= 0`),
  ],
);
