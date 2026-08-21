import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    // carrega .env.test independente de como o Vitest é invocado (CLI,
    // extensão do VSCode, debug) — sem isso, DATABASE_URL só existe quando
    // roda via `npm test`, que usa `node --env-file=.env.test`.
    env: loadEnv("test", process.cwd(), ""),
    // sem isso, um `npm run build` deixa .test.js em dist/ e o Vitest roda
    // cada teste duas vezes (fonte em src/ + build compilado em dist/).
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // testes de integração compartilham o mesmo banco Postgres — rodar em
    // paralelo faria um teste truncar as tabelas no meio do outro.
    fileParallelism: false,
  },
});
