import express from "express";
import { sql } from "./db/client.js";
import { errorHandler } from "./http/error-handler.js";
import { ledgerRouter } from "./modules/ledger/routes.js";

export const app = express();

app.use(express.json());

app.get("/health", async (_req, res, next) => {
  try {
    await sql`select 1`;
    res.json({ status: "ok" });
  } catch (err) {
    next(err);
  }
});

app.use(ledgerRouter);

app.use(errorHandler);
