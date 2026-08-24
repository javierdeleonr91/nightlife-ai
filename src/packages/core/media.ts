/**
 * Imágenes de perfil: reglas, rutas y validación.
 *
 * Todo lo que decide **qué** se puede subir y **dónde** va vive aquí, sin
 * dependencias y con tests. El módulo que habla con Supabase (lib/storage.ts)
 * solo transporta: no decide nada.
 *
 * Un único bucket, `profile-media`, para todo el contenido visual público de
 * perfiles, con la ruta contando de quién es cada archivo:
 *
 *   promoters/{promoterId}/avatar/{único}.{ext}
 *   promoters/{promoterId}/cover/{único}.{ext}
 *   clubs/{clubId}/logo/{único}.{ext}
 *   clubs/{clubId}/cover/{único}.{ext}
 *
 * El bucket es público **de lectura** porque estas imágenes forman parte de
 * páginas públicas. La escritura no: cada subida pasa por una URL firmada que
 * genera nuestro servidor después de comprobar quién eres y qué puedes tocar.
 * El `ownerId` de la ruta lo pone el servidor a partir de la sesión, nunca el
 * navegador — si lo pusiera el navegador, cualquiera podría escribir en la
 * carpeta de otro con solo cambiar un id.
 */

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** 5 MB. Una foto de perfil por encima de esto es un descuido, no un requisito. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const MEDIA_BUCKET = "profile-media";

export type MediaOwner = "promoter" | "club";
export type MediaKind = "avatar" | "cover" | "logo";

export interface MediaSlot {
  readonly owner: MediaOwner;
  readonly kind: MediaKind;
}

export const MEDIA_SLOTS = {
  "promoter-avatar": { owner: "promoter", kind: "avatar" },
  "promoter-cover": { owner: "promoter", kind: "cover" },
  "club-logo": { owner: "club", kind: "logo" },
  "club-cover": { owner: "club", kind: "cover" },
} as const satisfies Record<string, MediaSlot>;

export type MediaSlotId = keyof typeof MEDIA_SLOTS;

export function isMediaSlotId(value: string): value is MediaSlotId {
  return Object.prototype.hasOwnProperty.call(MEDIA_SLOTS, value);
}

export type UploadProblem = "TYPE_NOT_ALLOWED" | "TOO_LARGE" | "EMPTY";

/**
 * La misma comprobación que hace el navegador antes de abrir el selector, y
 * otra vez en el servidor antes de firmar nada. La del navegador es cortesía;
 * la del servidor es la que cuenta, porque la primera se salta con curl.
 */
export function validateUpload(args: {
  contentType: string;
  bytes: number;
}): UploadProblem | null {
  if (!ALLOWED_IMAGE_TYPES.includes(args.contentType as AllowedImageType)) {
    return "TYPE_NOT_ALLOWED";
  }
  if (!Number.isFinite(args.bytes) || args.bytes <= 0) return "EMPTY";
  if (args.bytes > MAX_IMAGE_BYTES) return "TOO_LARGE";
  return null;
}

export function uploadProblemMessage(problem: UploadProblem): string {
  switch (problem) {
    case "TYPE_NOT_ALLOWED":
      return "Use a JPG, PNG or WebP image.";
    case "TOO_LARGE":
      return "That image is over 5 MB. Try a smaller one.";
    case "EMPTY":
      return "That file looks empty.";
  }
}

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

/**
 * Nombre único, nunca el original.
 *
 * El nombre que trae el archivo del móvil de alguien puede llevar acentos,
 * espacios, barras o el nombre de un cliente. Se descarta entero y se genera
 * uno nuevo. Además, un nombre distinto en cada subida evita que la caché de
 * la CDN siga sirviendo la foto vieja después de cambiarla.
 */
export function buildMediaPath(args: {
  slot: MediaSlotId;
  /** Lo pone el servidor desde la sesión. Nunca llega del navegador. */
  ownerId: string;
  contentType: string;
  /** Se inyecta para poder testear. En producción, crypto.randomUUID(). */
  unique: string;
}): string {
  const slot = MEDIA_SLOTS[args.slot];
  const folder = slot.owner === "promoter" ? "promoters" : "clubs";
  const safeOwner = args.ownerId.replace(/[^A-Za-z0-9_-]/g, "");
  const safeUnique = args.unique.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeOwner || !safeUnique) throw new Error("Ruta de media inválida");
  return `${folder}/${safeOwner}/${slot.kind}/${safeUnique}.${extensionFor(args.contentType)}`;
}

/** URL pública de lectura, la que se guarda en base de datos y sale en la web. */
export function publicUrlFor(args: {
  supabaseUrl: string;
  bucket?: string;
  path: string;
}): string {
  const base = args.supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${args.bucket ?? MEDIA_BUCKET}/${args.path}`;
}

/**
 * ¿Esta URL es de nuestro bucket?
 *
 * Se usa antes de borrar. Un club puede haber pegado a mano la URL de su logo
 * alojado en otro sitio; borrar «la imagen anterior» sin comprobarlo sería
 * intentar borrar algo que no es nuestro, y en el mejor de los casos falla.
 */
export function storagePathFromPublicUrl(args: {
  url: string | null | undefined;
  supabaseUrl: string;
  bucket?: string;
}): string | null {
  if (!args.url) return null;
  const base = args.supabaseUrl.replace(/\/+$/, "");
  const prefix = `${base}/storage/v1/object/public/${args.bucket ?? MEDIA_BUCKET}/`;
  if (!args.url.startsWith(prefix)) return null;
  const path = args.url.slice(prefix.length);
  // Sin path traversal ni rutas vacías, aunque venga de nuestra propia base de
  // datos: un borrado con `..` dentro es exactamente el fallo que no se ve.
  if (!path || path.includes("..")) return null;
  return path;
}

/**
 * Los prefijos que le pertenecen a un dueño. El servidor comprueba que la ruta
 * que va a firmar empiece por uno de estos y no por la carpeta de otro.
 */
export function ownedPrefix(args: { slot: MediaSlotId; ownerId: string }): string {
  const slot = MEDIA_SLOTS[args.slot];
  const folder = slot.owner === "promoter" ? "promoters" : "clubs";
  return `${folder}/${args.ownerId}/${slot.kind}/`;
}

export function pathBelongsTo(args: {
  path: string;
  slot: MediaSlotId;
  ownerId: string;
}): boolean {
  return args.path.startsWith(ownedPrefix({ slot: args.slot, ownerId: args.ownerId }));
}
