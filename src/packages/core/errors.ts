/**
 * Errores de dominio con código estable.
 *
 * El código viaja al cliente; el detalle se queda en el log. Un recurso de
 * otro tenant devuelve NOT_FOUND y nunca FORBIDDEN: un 403 confirmaría
 * que ese recurso existe.
 */

export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_FORBIDDEN"
  | "PARSE_FAILED"
  | "LLM_UNAVAILABLE"
  // Una parte del producto que depende de un servicio externo que no está
  // configurado o no responde. No es culpa de quien hace la petición, y no es
  // permanente: por eso 503 y no 500 ni 422.
  | "SERVICE_UNAVAILABLE"
  | "RESPONSE_REJECTED"
  | "BUDGET_EXCEEDED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SOURCE_UNAVAILABLE: 502,
  SOURCE_FORBIDDEN: 403,
  PARSE_FAILED: 422,
  LLM_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  RESPONSE_REJECTED: 500,
  BUDGET_EXCEEDED: 402,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static notFound(what = "Recurso"): AppError {
    return new AppError("NOT_FOUND", `${what} no encontrado`);
  }
  static forbidden(message = "No tienes permiso para hacer esto"): AppError {
    return new AppError("FORBIDDEN", message);
  }
  static unauthenticated(): AppError {
    return new AppError("UNAUTHENTICATED", "Necesitas iniciar sesión");
  }
  static validation(message: string, details?: unknown): AppError {
    return new AppError("VALIDATION_FAILED", message, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Resultado sin excepciones para operaciones que fallan por diseño (parsers, fuentes). */
export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
