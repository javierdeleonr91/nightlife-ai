/**
 * Cifrado de secretos en reposo.
 *
 * Aquí dentro solo entra una cosa: la API key de Fourvenues de cada club. Es
 * una credencial que da acceso a los datos de su negocio, así que no puede
 * estar en texto plano en la base de datos, ni salir jamás hacia el navegador,
 * ni aparecer en un log.
 *
 * AES-256-GCM: cifra y autentica a la vez, así que un valor manipulado en la
 * base de datos falla al abrirse en lugar de descifrarse en basura silenciosa.
 * Nonce de 96 bits nuevo en cada sellado — reutilizar uno con GCM rompe el
 * cifrado entero, así que nunca se deriva de nada, siempre es aleatorio.
 *
 * El formato guardado es `v1.<nonce b64url>.<ciphertext+tag b64url>`. Lleva
 * versión delante para poder rotar de algoritmo sin adivinar qué es cada fila.
 *
 * La clave maestra vive en la variable de entorno NIGHTLIFE_SECRET_KEY y no
 * está en el repositorio. Sin ella, esto se niega a funcionar en vez de
 * inventarse una por defecto: una clave por defecto es lo mismo que no cifrar.
 */

const VERSION = "v1";
const NONCE_BYTES = 12;

export class SecretBoxError extends Error {}

// Mismos helpers que packages/auth/crypto.ts: base64url sin dependencias, con
// WebCrypto, que es lo que hay tanto en Node como en el runtime de Vercel.
function b64url(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Convierte la clave maestra en material utilizable.
 *
 * Se espera 32 bytes en base64 o base64url. Se comprueba la longitud: una
 * clave corta cifra igual de bien y protege mucho peor, y ese fallo no se ve
 * hasta que es tarde.
 */
export async function importMasterKey(raw: string): Promise<CryptoKey> {
  const bytes = unb64url(raw.trim());
  if (bytes.length !== 32) {
    throw new SecretBoxError(
      "NIGHTLIFE_SECRET_KEY debe ser de 32 bytes en base64. Genérala con: openssl rand -base64 32",
    );
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function seal(plaintext: string, key: CryptoKey): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${b64url(nonce)}.${b64url(new Uint8Array(cipher))}`;
}

export async function open(sealed: string, key: CryptoKey): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new SecretBoxError("Secreto con formato desconocido.");
  }
  const nonce = unb64url(parts[1] as string);
  const cipher = unb64url(parts[2] as string);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      cipher,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // No se distingue «clave equivocada» de «dato manipulado»: hacerlo daría
    // información gratis a quien esté probando.
    throw new SecretBoxError("No se pudo descifrar el secreto.");
  }
}

/**
 * Los cuatro últimos caracteres, para que el club reconozca cuál de sus keys
 * tiene puesta sin que le enseñemos la key. Es lo único de un secreto que
 * puede viajar al navegador.
 */
export function secretHint(plaintext: string): string {
  const tail = plaintext.trim().slice(-4);
  return tail.length === 4 ? `••••${tail}` : "••••";
}

/**
 * Quita cualquier aparición de un secreto de un texto antes de guardarlo o
 * enseñarlo. Es la última red: lo correcto es no meterlo nunca, pero un
 * mensaje de error de una librería puede traerlo de vuelta sin avisar.
 */
export function redact(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
