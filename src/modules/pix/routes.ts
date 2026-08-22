import { Router } from "express";
import { AppError } from "../../http/error-handler.js";
import { parseReverseTransactionInput, UUID_RE } from "../ledger/validate.js";
import {
  createPixCharge,
  createPixKey,
  getPixCharge,
  payPixCharge,
  refundPixPayment,
} from "./service.js";
import {
  parseCreatePixChargeInput,
  parseCreatePixKeyInput,
  parsePayPixChargeInput,
} from "./validate.js";

export const pixRouter = Router();

pixRouter.post("/pix/keys", async (req, res, next) => {
  try {
    const input = parseCreatePixKeyInput(req.body);
    const pixKey = await createPixKey(input);
    res.status(201).json(pixKey);
  } catch (err) {
    next(err);
  }
});

pixRouter.post("/pix/charges", async (req, res, next) => {
  try {
    const input = parseCreatePixChargeInput(req.body);
    const result = await createPixCharge(input);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

pixRouter.post("/pix/pay", async (req, res, next) => {
  try {
    const input = parsePayPixChargeInput(req.body);
    const result = await payPixCharge(input);
    res.status(result.replayed ? 200 : 201).json({
      transaction: result.transaction,
      entries: result.entries,
      charge: result.charge,
      qrPayload: result.qrPayload,
    });
  } catch (err) {
    next(err);
  }
});

pixRouter.post(
  "/pix/payments/:transactionId/refund",
  async (req, res, next) => {
    try {
      const { transactionId } = req.params;
      if (!transactionId || !UUID_RE.test(transactionId)) {
        throw new AppError(
          400,
          "invalid_request",
          "transactionId precisa ser um uuid",
        );
      }

      const { idempotencyKey } = parseReverseTransactionInput(req.body);
      const result = await refundPixPayment(transactionId, idempotencyKey);

      res.status(result.replayed ? 200 : 201).json({
        transaction: result.transaction,
        entries: result.entries,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Simula o "scan" do QR: devolve o payload decodificado a partir do txid.
pixRouter.get("/pix/charges/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id || !UUID_RE.test(id)) {
      throw new AppError(400, "invalid_request", "id precisa ser um uuid");
    }

    const result = await getPixCharge(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
