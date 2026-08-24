import "server-only";

import {
  MEDIA_BUCKET,
  publicUrlFor,
  storagePathFromPublicUrl,
} from "@nightlife/core/media";

/**
 * Supabase Storage — transporte, y nada más.
 *
 * Las reglas (qué tipos, qué tamaño, qué ruta le corresponde a quién) viven en
 * `packages/core/media.ts` y se comprueban antes de llamar aquí. Este módulo
 * solo sabe hablar con la API REST de Storage:
 *
 *   POST   {base}/object/upload/sign/{bucket}/{path}   → { url: "...?token=..." }
 *   PUT    {base}/object/upload/sign/{bucket}/{path}?token=...   (lo hace el navegador)
 *   DELETE {base}/object/{bucket}   body { prefixes: [path] }
 *   GET    {base}/object/public/{bucket}/{path}        (lectura pública)
 *
 * `import "server-only"` en la primera línea: si algún día alguien importa
 * esto desde un componente de cliente, el build falla en vez de mandar la
 * SERVICE ROLE KEY al navegador. Esa clave salta el RLS entero; es la
 * credencial más peligrosa del proyecto.
 *
 * Nada de lo que sale de aquí contiene la clave. Los errores se traducen a
 * códigos nuestros antes de subir, igual que con Fourvenues.
 */

export type StorageErrorCode = "NOT_CONFIGURED" | "UPSTREAM" | "NETWORK";

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
  }

  get publicMessage(): string {
    return this.code === "NOT_CONFIGURED"
      ? "Image uploads aren't set up on this deployment yet."
      : "Couldn't upload the image. Try again.";
  }
}

interface StorageConfig {
  readonly supabaseUrl: string;
  readonly serviceKey: string;
  readonly bucket: string;
}

function config(): StorageConfig | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    serviceKey,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || MEDIA_BUCKET,
  };
}

/**
 * ¿Se puede subir en este despliegue?
 *
 * La interfaz lo pregunta para enseñar «pega una URL» en lugar de un botón de
 * subir que no funcionaría. Prefiero una pantalla honesta a un botón roto.
 */
export function storageConfigured(): boolean {
  return config() !== null;
}

function requireConfig(): StorageConfig {
  const found = config();
  if (!found) {
    throw new StorageError(
      "NOT_CONFIGURED",
      "SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY no están configuradas.",
    );
  }
  return found;
}

function headers(cfg: StorageConfig): Record<string, string> {
  return {
    apikey: cfg.serviceKey,
    authorization: `Bearer ${cfg.serviceKey}`,
    "content-type": "application/json",
  };
}

export interface SignedUpload {
  /** URL absoluta a la que el navegador hace PUT con el archivo. */
  readonly uploadUrl: string;
  /** Ruta dentro del bucket. Se devuelve para confirmarla después. */
  readonly path: string;
  /** URL pública de lectura, la que acabará en base de datos. */
  readonly publicUrl: string;
}

/**
 * Autoriza una subida concreta a una ruta concreta.
 *
 * El token que devuelve Supabase vale para **esa** ruta y caduca. El navegador
 * nunca ve la service key: solo un permiso de un solo uso para escribir un
 * archivo en el sitio que nuestro servidor ya ha decidido.
 */
export async function createSignedUpload(path: string): Promise<SignedUpload> {
  const cfg = requireConfig();
  const endpoint = `${cfg.supabaseUrl}/storage/v1/object/upload/sign/${cfg.bucket}/${path}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers(cfg), "x-upsert": "true" },
      body: JSON.stringify({}),
      cache: "no-store",
    });
  } catch {
    throw new StorageError("NETWORK", "No se pudo contactar con Storage");
  }

  if (!response.ok) {
    // El cuerpo puede traer detalles del proyecto; no se propaga.
    throw new StorageError("UPSTREAM", `Storage respondió ${response.status}`);
  }

  const data = (await response.json().catch(() => null)) as { url?: string } | null;
  if (!data?.url) throw new StorageError("UPSTREAM", "Storage no devolvió URL firmada");

  // Supabase devuelve una ruta relativa a /storage/v1.
  const uploadUrl = data.url.startsWith("http")
    ? data.url
    : `${cfg.supabaseUrl}/storage/v1${data.url.startsWith("/") ? "" : "/"}${data.url}`;

  return {
    uploadUrl,
    path,
    publicUrl: publicUrlFor({ supabaseUrl: cfg.supabaseUrl, bucket: cfg.bucket, path }),
  };
}

/**
 * Comprueba que el archivo está de verdad ahí antes de apuntarlo en la base de
 * datos. Sin esto, un navegador que cierra la pestaña a mitad de la subida
 * dejaría un perfil apuntando a una imagen que no existe.
 */
export async function objectExists(path: string): Promise<boolean> {
  const cfg = requireConfig();
  try {
    const response = await fetch(
      `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.bucket}/${path}`,
      { method: "HEAD", cache: "no-store" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Borra la imagen anterior. Se llama **después** de que la nueva esté subida y
 * apuntada, nunca antes: si el orden se invierte y la subida falla, el perfil
 * se queda sin foto y la vieja ya no está.
 *
 * Devuelve si borró o no, pero no lanza: que no se pueda limpiar un archivo
 * viejo no es motivo para que al usuario le falle el guardado.
 */
export async function deleteObject(path: string): Promise<boolean> {
  const cfg = config();
  if (!cfg) return false;
  try {
    const response = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${cfg.bucket}`, {
      method: "DELETE",
      headers: headers(cfg),
      body: JSON.stringify({ prefixes: [path] }),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Borra una imagen anterior solo si es nuestra. Ver core/media.ts. */
export async function deleteIfOurs(url: string | null | undefined): Promise<void> {
  const cfg = config();
  if (!cfg || !url) return;
  const path = storagePathFromPublicUrl({
    url,
    supabaseUrl: cfg.supabaseUrl,
    bucket: cfg.bucket,
  });
  if (path) await deleteObject(path);
}

/**
 * URL pública de una ruta ya subida.
 *
 * Se recompone del path en vez de aceptar la URL que mande el navegador: si la
 * aceptáramos tal cual, alguien podría guardar en su perfil una URL apuntando
 * a cualquier sitio de internet.
 */
export function publicUrlForPath(path: string): string {
  const cfg = requireConfig();
  return publicUrlFor({ supabaseUrl: cfg.supabaseUrl, bucket: cfg.bucket, path });
}

/** El host del bucket, para configurar next/image sin escribirlo a mano. */
export function storageHost(): string | null {
  const cfg = config();
  if (!cfg) return null;
  try {
    return new URL(cfg.supabaseUrl).hostname;
  } catch {
    return null;
  }
}
