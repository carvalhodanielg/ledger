import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const testUrl = process.env.DATABASE_URL;
if (!testUrl) {
  throw new Error("DATABASE_URL não configurada (ver .env.test)");
}

const parsed = new URL(testUrl);
const dbName = parsed.pathname.replace(/^\//, "");

// Precisa de uma conexão fora do banco de teste pra poder DROP/CREATE ele —
// não dá pra derrubar o banco que a própria conexão está usando.
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

const admin = postgres(adminUrl.toString());

// Recria do zero a cada rodada de testes, aplicando a migration atual — evita
// o banco de teste ficar com schema desatualizado em relação a drizzle/.
await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE "${dbName}"`);
await admin.end();

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "drizzle",
  "0000_overjoyed_skaar.sql",
);
const migrationSql = readFileSync(migrationPath, "utf-8");

const db = postgres(testUrl);
for (const statement of migrationSql.split("--> statement-breakpoint")) {
  const trimmed = statement.trim();
  if (trimmed) {
    await db.unsafe(trimmed);
  }
}
await db.end();

console.log(`banco de teste "${dbName}" recriado e migrado.`);
