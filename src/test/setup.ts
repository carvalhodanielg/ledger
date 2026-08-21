import { beforeEach } from "vitest";
import { sql } from "../db/client.js";

beforeEach(async () => {
  await sql`TRUNCATE TABLE entries, balances, transactions, accounts RESTART IDENTITY CASCADE`;
});
