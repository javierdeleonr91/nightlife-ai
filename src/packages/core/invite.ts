/**
 * Códigos de invitación de club.
 *
 * Cómo entra un RRPP en un club sin que pueda meterse en cualquiera: el club
 * genera un código, se lo pasa por donde quiera, y el promoter lo canjea. El
 * **código es el permiso**. El navegador nunca manda un `clubId`: manda un
 * código, y el servidor decide a qué club pertenece.
 *
 * Eso cierra el agujero obvio de la alternativa fácil — «POST /clubs/:id/join»
 * — donde cambiar un id en el JSON te mete en el club de otro.
 *
 * El alfabeto no tiene 0/O ni 1/I/L. Estos códigos se dictan por teléfono en
 * la puerta de un club a las dos de la mañana, y un cero que alguien lee como
 * o mayúscula es un código que no funciona y una llamada de soporte.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;

/** Los pares que la gente confunde al leer o al teclear. */
const CONFUSIONS: Record<string, string> = {
  "0": "O",
  O: "O",
  "1": "I",
  I: "I",
  L: "I",
};

/**
 * Genera un código.
 *
 * `randomBytes` se inyecta para poder testear sin aleatoriedad. En producción
 * es `crypto.getRandomValues`: un `Math.random()` aquí sería adivinable, y
 * adivinar un código es entrar en un club sin permiso.
 */
export function generateInviteCode(randomBytes: Uint8Array): string {
  if (randomBytes.length < INVITE_CODE_LENGTH) {
    throw new Error("Hacen falta al menos 8 bytes aleatorios para un código");
  }
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    const byte = randomBytes[i] as number;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/**
 * Normaliza lo que teclea una persona.
 *
 * Mayúsculas, sin espacios ni guiones, y las confusiones típicas resueltas a
 * la letra que sí está en el alfabeto. Alguien que teclea `mon-2o24 ab` acaba
 * en `MON2O24AB` y funciona.
 */
export function normalizeInviteCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let out = "";
  for (const char of cleaned) out += CONFUSIONS[char] ?? char;
  return out;
}

export type InviteProblem = "MALFORMED" | "REVOKED" | "EXPIRED" | "USED_UP";

export function inviteProblemMessage(problem: InviteProblem): string {
  switch (problem) {
    case "MALFORMED":
      return "That code doesn't look right. Check it and try again.";
    case "REVOKED":
      return "That invite has been cancelled. Ask the club for a new one.";
    case "EXPIRED":
      return "That invite has expired. Ask the club for a new one.";
    case "USED_UP":
      return "That invite has already been used. Ask the club for a new one.";
  }
}

/** ¿Tiene forma de código? Se comprueba antes de tocar la base de datos. */
export function looksLikeInviteCode(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false;
  for (const char of code) if (!ALPHABET.includes(char)) return false;
  return true;
}

/** `maxUses = 0` significa reutilizable sin límite. */
export const MAX_USES_UNLIMITED = 0;

/**
 * La condición que impide pasarse de usos, o `null` si no hay límite.
 *
 * Existe como función con nombre por un motivo concreto: la versión anterior
 * era un ternario incrustado dentro de un `where` de Prisma, correcto pero
 * fácil de leer mal y facilísimo de romper. Con `maxUses = 0` la condición
 * `usedCount < 0` no se cumple nunca, así que un código reutilizable no se
 * podría canjear **ni una vez**. El caso ilimitado tiene que devolver `null`
 * — sin condición — y no `{ lt: 0 }`.
 *
 * Al ser una función pura se puede probar los dos caminos directamente, en vez
 * de comprobar por grep que el ternario sigue ahí.
 */
export function usageCondition(maxUses: number): { lt: number } | null {
  return maxUses > MAX_USES_UNLIMITED ? { lt: maxUses } : null;
}

export interface InviteState {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** 0 = sin límite. */
  readonly maxUses: number;
  readonly usedCount: number;
}

/**
 * ¿Se puede canjear?
 *
 * El orden de las comprobaciones es el orden en que se lo explicarías a
 * alguien: primero si sigue viva, luego si le queda tiempo, luego si le quedan
 * usos. Cada motivo tiene su mensaje, porque «no válido» no le dice a nadie si
 * tiene que pedir otro código o esperar.
 */
export function inviteProblem(state: InviteState, now: Date): InviteProblem | null {
  if (state.revokedAt) return "REVOKED";
  if (state.expiresAt && state.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (state.maxUses > 0 && state.usedCount >= state.maxUses) return "USED_UP";
  return null;
}

/** Cómo se enseña un código: en dos mitades, que se leen mucho mejor. */
export function formatInviteCode(code: string): string {
  return code.length === INVITE_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
