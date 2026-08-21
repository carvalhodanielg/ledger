import { Router } from "express";
import { AppError } from "../../http/error-handler.js";
import {
  createTransaction,
  getAccountBalance,
  getAccountStatement,
} from "./service.js";
import { parseCreateTransactionInput, UUID_RE } from "./validate.js";

export const ledgerRouter = Router();

ledgerRouter.post("/transactions", async (req, res, next) => {
  try {
    const input = parseCreateTransactionInput(req.body);
    const result = await createTransaction(input);


    //replayed so acontece caso aconteça algo entre gravar a transacao no banco + entry 
    //cliente envia denovo o mesmo idempootencyKey, recebe 200 pra identificar que aquela transação ja aconteceu anteriormente
    
    res.status(result.replayed ? 200 : 201).json({
      transaction: result.transaction,
      entries: result.entries,
    });
  } catch (err) {
    next(err);
  }
});

ledgerRouter.get("/accounts/:id/balance", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      throw new AppError(400, "invalid_request", "id precisa ser um uuid");
    }

    const result = await getAccountBalance(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const DEFAULT_STATEMENT_LIMIT = 50;
const MAX_STATEMENT_LIMIT = 200;

ledgerRouter.get("/accounts/:id/statement", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      throw new AppError(400, "invalid_request", "id precisa ser um uuid");
    }

    const limit = parseLimit(req.query.limit);
    const result = await getAccountStatement(id, limit);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_STATEMENT_LIMIT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_STATEMENT_LIMIT) {
    throw new AppError(
      400,
      "invalid_request",
      `limit precisa ser um inteiro entre 1 e ${MAX_STATEMENT_LIMIT}`,
    );
  }

  return value;
}
