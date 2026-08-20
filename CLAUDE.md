# Ledger — partidas dobradas com simulador de Pix

Motor contábil de partida dobrada (double-entry) onde é estruturalmente
impossível uma transação ficar desbalanceada, com uma camada de simulação
de Pix por cima. Ver `what-is.md` para a visão completa e `roadmap.md` para
o plano semana a semana.

## Stack

- Node + TypeScript (ESM, `NodeNext`), rodado com `tsx`
- Postgres (via Docker Compose) — não trocar por Mongo: `FOR UPDATE` e
  transações ACID são o ponto do projeto
- Query builder fino (Knex ou Drizzle) — nunca um ORM que esconda o SQL
- Dinheiro é sempre inteiro em centavos, nunca float

## Comandos

- `docker compose up -d` — sobe o Postgres (porta 5432, db `ledger`)
- `npm run dev` — roda a API em watch mode
- `npm run build` / `npm start` — build e run de produção
- `cp .env.example .env` — configura `DATABASE_URL` localmente

## Modelo de dados (núcleo)

Quatro tabelas: `accounts`, `transactions`, `entries`, `balances` (projeção
opcional). Regra de ouro: soma dos débitos de uma transação == soma dos
créditos, sempre — garantida em código e em constraint de banco.

## Princípios que não devem ser quebrados

- Saldo nunca é uma coluna que se incrementa/decrementa — é sempre a soma
  das entries (ou uma projeção recalculável a partir delas).
- `amount` é sempre positivo; o sinal vem de `direction` (debit/credit).
- Transações são imutáveis: reversão cria uma transação nova espelhada,
  nunca edita ou deleta a original.
- Toda operação que muda dinheiro exige `idempotency_key` do cliente.
- A camada de Pix não tem lógica financeira própria — só traduz chamadas
  para o motor de ledger da camada 1. Resistir à tentação de escrever
  lógica de saldo/reversão dentro do código de Pix.

## Fases (ver roadmap.md para o detalhe semana a semana)

1. Núcleo contábil (schema, `POST /transactions`, saldo, extrato, reversão)
2. Concorrência (lock pessimista ou constraint de banco) + idempotência
3. Pix por cima do motor (chaves, QR code, pay, refund)
4. Reconciliação, testes, README com evidência do teste de concorrência

Se o tempo apertar, corta a fase 3 (Pix) antes de cortar qualquer coisa da
fase 2 (concorrência) — o teste de concorrência é o que prova o projeto.
