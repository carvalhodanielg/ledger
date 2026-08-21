import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL não configurada (ver .env.example)");
}

// client "cru" exposto também, pra quando precisar de coisa que o Drizzle
// não modela (ex: SELECT ... FOR UPDATE explícito no dia da concorrência).
export const sql = postgres(connectionString);

export const db = drizzle(sql, { schema });
