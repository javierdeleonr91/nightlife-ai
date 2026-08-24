import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import {
  buildMediaPath,
  pathBelongsTo,
  uploadProblemMessage,
  validateUpload,
} from "@nightlife/core/media";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import {
  createSignedUpload,
  deleteIfOurs,
  objectExists,
  publicUrlForPath,
  storageConfigured,
} from "@/lib/storage";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Foto y portada del promoter.
 *
 * Tres pasos, y el orden importa:
 *
 *   POST   pide permiso  → validamos y devolvemos una URL firmada
 *   (el navegador sube directo a Supabase con esa URL)
 *   PUT    confirma      → comprobamos que existe, guardamos, y SOLO ENTONCES
 *                          borramos la anterior
 *   DELETE quita         → limpia el campo y borra el archivo si es nuestro
 *
 * El `promoterId` de la ruta sale de la sesión, no del cuerpo de la petición.
 * Si viniera del navegador, cualquiera podría firmar una subida a la carpeta
 * de otro promoter cambiando un id en el JSON.
 */

const SLOTS = { avatar: "promoter-avatar", cover: "promoter-cover" } as const;
type SlotName = keyof typeof SLOTS;

const authorizeSchema = z.object({
  slot: z.enum(["avatar", "cover"]),
  contentType: z.string().min(3).max(60),
  size: z.number().int().positive(),
});

const confirmSchema = z.object({
  slot: z.enum(["avatar", "cover"]),
  path: z.string().min(3).max(400),
});

const removeSchema = z.object({ slot: z.enum(["avatar", "cover"]) });

/**
 * Los datos que se escriben, por slot y de forma explícita.
 *
 * Con una clave computada (`{ [FIELD[slot]]: url }`) TypeScript pierde de vista
 * qué columna se está tocando y Prisma deja de poder comprobarlo. Escribirlo
 * así es más largo y es la única versión que el compilador puede verificar.
 */
function promoterData(slot: SlotName, value: string | null) {
  return slot === "avatar" ? { photoUrl: value } : { coverImageUrl: value };
}

async function currentUrl(promoterId: string, slot: SlotName): Promise<string | null> {
  const promoter = await prisma.promoter.findUnique({
    where: { id: promoterId },
    select: { photoUrl: true, coverImageUrl: true },
  });
  return (slot === "avatar" ? promoter?.photoUrl : promoter?.coverImageUrl) ?? null;
}

/** Paso 1: autorizar. */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("You don't have a promoter profile");
    if (!storageConfigured()) {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "Image uploads aren't set up on this deployment yet.",
      );
    }

    const body = await parseBody(request, authorizeSchema);

    // La misma validación que hace el navegador, otra vez. La del navegador se
    // salta con curl; esta no.
    const problem = validateUpload({ contentType: body.contentType, bytes: body.size });
    if (problem) throw AppError.validation(uploadProblemMessage(problem));

    const path = buildMediaPath({
      slot: SLOTS[body.slot],
      ownerId: principal.promoterId,
      contentType: body.contentType,
      unique: crypto.randomUUID(),
    });

    const signed = await createSignedUpload(path);
    return NextResponse.json({
      uploadUrl: signed.uploadUrl,
      path: signed.path,
      publicUrl: signed.publicUrl,
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Paso 2: confirmar. Aquí es donde se toca la base de datos. */
export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("You don't have a promoter profile");

    const body = await parseBody(request, confirmSchema);

    // La ruta tiene que caer dentro de su propia carpeta. Una petición que
    // confirme la imagen de otro promoter se rechaza aquí.
    if (!pathBelongsTo({ path: body.path, slot: SLOTS[body.slot], ownerId: principal.promoterId })) {
      throw AppError.forbidden("That image doesn't belong to you.");
    }

    if (!(await objectExists(body.path))) {
      throw AppError.validation("The upload didn't finish. Try again.");
    }

    const previous = await currentUrl(principal.promoterId, body.slot);
    // La URL pública se recompone del path en lugar de fiarse de la que mandó
    // el navegador: si la aceptáramos, alguien podría guardar en su perfil una
    // URL apuntando a cualquier sitio.
    const publicUrl = publicUrlForPath(body.path);

    await prisma.promoter.update({
      where: { id: principal.promoterId },
      data: promoterData(body.slot, publicUrl),
    });

    // Ahora sí: la nueva está subida y guardada, así que la vieja sobra.
    if (previous && previous !== publicUrl) await deleteIfOurs(previous);

    return NextResponse.json({ ok: true, url: publicUrl });
  } catch (error) {
    return apiError(error);
  }
}

/** Paso 3 (opcional): quitar. */
export async function DELETE(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("You don't have a promoter profile");

    const body = await parseBody(request, removeSchema);
    const previous = await currentUrl(principal.promoterId, body.slot);

    await prisma.promoter.update({
      where: { id: principal.promoterId },
      data: promoterData(body.slot, null),
    });
    if (previous) await deleteIfOurs(previous);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
