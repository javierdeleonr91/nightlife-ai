import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, isAppError } from "@nightlife/core/errors";

/**
 * Envoltura común de los handlers de API.
 *
 * Un solo sitio decide el formato de error, qué se registra y qué NO sale al
 * cliente. Nunca stack traces, nunca nombres de tabla, nunca IDs de otros
 * tenants.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string };
}

export function apiError(error: unknown, requestId = crypto.randomUUID()): NextResponse<ApiErrorBody> {
  if (isAppError(error)) {
    if (error.status >= 500) console.error(`[${requestId}] ${error.code}`, error.message);
    return NextResponse.json(
      { error: { code: error.code, message: error.message, requestId } },
      { status: error.status },
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          requestId,
        },
      },
      { status: 422 },
    );
  }

  console.error(`[${requestId}] error no controlado`, error);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Algo ha fallado por nuestra parte", requestId } },
    { status: 500 },
  );
}

export function handler<T>(fn: () => Promise<T>): Promise<NextResponse> {
  return fn()
    .then((data) => NextResponse.json(data))
    .catch((error: unknown) => apiError(error));
}

export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw AppError.validation("El cuerpo de la petición no es JSON válido");
  }
  return schema.parse(json);
}

/**
 * Limitador en memoria. Suficiente para una sola instancia y para desarrollo;
 * en producción con varias instancias hace falta Redis — está anotado como
 * deuda consciente en el README, no olvidado.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowSeconds: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new AppError("RATE_LIMITED", "Demasiadas peticiones. Espera un momento.");
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
