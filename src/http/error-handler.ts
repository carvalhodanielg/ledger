import type { NextFunction, Request, Response } from "express";

// Erros de domínio (ex: transação desbalanceada) devem ser lançados como
// AppError com um status HTTP explícito — o handler central decide como
// isso vira resposta, a camada de domínio não sabe nada de HTTP.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "internal_server_error" });
}
