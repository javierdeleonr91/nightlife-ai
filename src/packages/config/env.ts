import { z } from "zod";

/**
 * Configuración validada al arrancar.
 *
 * Si falta una variable, la app no arranca. Es preferible a descubrirlo el
 * viernes a las dos de la mañana porque el bot responde 500.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),

  /** Firma de cookies de sesión y de tokens de chat. Mínimo 32 caracteres. */
  AUTH_SECRET: z.string().min(32),
  /** Sal base para hashear identificadores de clientes finales. */
  CUSTOMER_HASH_PEPPER: z.string().min(16),

  APP_URL: z.string().url().default("http://localhost:3000"),

  /** Sin clave, el bot funciona solo con plantillas y FAQ. Degrada, no rompe. */
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-4-5"),
  LLM_CLASSIFIER_MODEL: z.string().default("claude-haiku-4-5"),

  /** Identificación del bot ante la fuente externa. Debe ser una URL real. */
  SOURCE_CONTACT_URL: z.string().url().default("https://nightlifeautomatico.com/bot"),
  SOURCE_MIN_INTERVAL_MS: z.coerce.number().int().min(1000).default(3000),

  /** TTL del precio en segundos. Configurable sin desplegar código. */
  PRICE_TTL_SECONDS: z.coerce.number().int().min(60).default(600),
  /** Retención de conversaciones en días (RGPD). */
  CONVERSATION_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

  /** Presupuesto diario de IA por club, en céntimos. */
  DEFAULT_AI_DAILY_BUDGET_CENTS: z.coerce.number().int().min(0).default(500),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Configuración inválida:\n  ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Nada de esto puede llegar al navegador. La comprobación es explícita. */
export const SERVER_ONLY_KEYS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "CUSTOMER_HASH_PEPPER",
  "LLM_API_KEY",
] as const;
