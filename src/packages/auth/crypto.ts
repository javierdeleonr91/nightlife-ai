/**
 * Sesión y contraseñas con WebCrypto.
 *
 * Sin bcryptjs ni jose: WebCrypto está en Node y en el runtime edge, así que
 * el mismo código vale para el middleware y para los handlers. PBKDF2-SHA256
 * con 210.000 iteraciones es la recomendación actual de OWASP para este
 * algoritmo.
 *
 * Nota de arquitectura: esto es deliberadamente pequeño y está aislado detrás
 * de @nightlife/auth. El día que hagan falta OAuth o magic links, se sustituye
 * este módulo por Auth.js sin tocar nada más — los handlers solo conocen
 * getSession() y createSessionCookie().
 */

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Comparación en tiempo constante: evita distinguir hashes por latencia. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Formato: pbkdf2$<iteraciones>$<salt>$<hash>. Autodescriptivo y migrable. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1] as string, 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const salt = fromBase64Url(parts[2] as string);
  const expected = fromBase64Url(parts[3] as string);
  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// ── JWT HS256 ────────────────────────────────────────────────────────

export interface SessionClaims {
  readonly sub: string;
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSessionToken(
  claims: Omit<SessionClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return `${data}.${toBase64Url(signature)}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature) as unknown as BufferSource,
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SessionClaims;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Token de sesión del chat público. Ata la conversación al widget que la
 * abrió, de modo que /api/v1/chat no sea un endpoint anónimo que cualquiera
 * pueda martillear gastando LLM del club.
 */
export async function signChatToken(
  data: { conversationId: string; clubId: string; promoterId?: string },
  secret: string,
  ttlSeconds = 60 * 60 * 6,
): Promise<string> {
  return signSessionToken(
    { sub: data.conversationId, email: `${data.clubId}:${data.promoterId ?? ""}` },
    secret,
    ttlSeconds,
  );
}

export async function verifyChatToken(
  token: string,
  secret: string,
): Promise<{ conversationId: string; clubId: string; promoterId: string | null } | null> {
  const claims = await verifySessionToken(token, secret);
  if (!claims) return null;
  const [clubId, promoterId] = claims.email.split(":");
  if (!clubId) return null;
  return {
    conversationId: claims.sub,
    clubId,
    promoterId: promoterId && promoterId.length > 0 ? promoterId : null,
  };
}

/**
 * Hash del identificador del cliente final (handle de Instagram, teléfono).
 * Con sal por club: el mismo número en dos clubs da dos hashes distintos, así
 * que no se pueden cruzar clientes entre tenants. Minimización del RGPD hecha
 * en el esquema, no en la política de privacidad.
 */
export async function hashCustomerHandle(handle: string, clubSalt: string): Promise<string> {
  const data = encoder.encode(`${clubSalt}:${handle.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}
