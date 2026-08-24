import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import {
  buildMediaPath,
  pathBelongsTo,
  uploadProblemMessage,
  validateUpload,
} from "@nightlife/core/media";
import { assertPermission, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
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
 * Logo y portada del club. Mismo flujo de tres pasos que el del promoter.
 *
 * La diferencia es de quién es la carpeta: aquí el dueño es el club, no la
 * persona, así que hace falta el permiso `club:branding`. Un manager del club
 * no puede cambiar el logo; un promoter que trabaja con el club, tampoco. El
 * `clubId` viene de la ruta pero se comprueba contra los permisos reales de la
 * sesión — nunca se da por bueno porque lo mande el navegador.
 */

const SLOTS = { logo: "club-logo", cover: "club-cover" } as const;
type SlotName = keyof typeof SLOTS;

const authorizeSchema = z.object({
  slot: z.enum(["logo", "cover"]),
  contentType: z.string().min(3).max(60),
  size: z.number().int().positive(),
});

const confirmSchema = z.object({
  slot: z.enum(["logo", "cover"]),
  path: z.string().min(3).max(400),
});

const removeSchema = z.object({ slot: z.enum(["logo", "cover"]) });

/**
 * Los datos que se escriben, por slot y de forma explícita.
 *
 * Con una clave computada (`{ [FIELD[slot]]: url }`) TypeScript pierde de vista
 * qué columna se está tocando y Prisma deja de poder comprobarlo. Escribirlo
 * así es más largo y es la única versión que el compilador puede verificar.
 */
function brandData(slot: SlotName, value: string | null) {
  return slot === "logo" ? { logoUrl: value } : { coverImageUrl: value };
}

async function currentUrl(clubId: string, slot: SlotName): Promise<string | null> {
  const brand = await withOwnerRls({ type: "CLUB", clubId }, (tx) =>
    tx.brandSettings.findUnique({
      where: { clubId },
      select: { logoUrl: true, coverImageUrl: true },
    }),
  );
  return (slot === "logo" ? brand?.logoUrl : brand?.coverImageUrl) ?? null;
}

export async function POST(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:branding");
    if (!storageConfigured()) {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "Image uploads aren't set up on this deployment yet.",
      );
    }

    const body = await parseBody(request, authorizeSchema);
    const problem = validateUpload({ contentType: body.contentType, bytes: body.size });
    if (problem) throw AppError.validation(uploadProblemMessage(problem));

    const path = buildMediaPath({
      slot: SLOTS[body.slot],
      ownerId: clubId,
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

export async function PUT(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:branding");

    const body = await parseBody(request, confirmSchema);
    if (!pathBelongsTo({ path: body.path, slot: SLOTS[body.slot], ownerId: clubId })) {
      throw AppError.forbidden("That image doesn't belong to this club.");
    }
    if (!(await objectExists(body.path))) {
      throw AppError.validation("The upload didn't finish. Try again.");
    }

    const previous = await currentUrl(clubId, body.slot);
    const publicUrl = publicUrlForPath(body.path);

    await withOwnerRls({ type: "CLUB", clubId }, (tx) =>
      tx.brandSettings.upsert({
        where: { clubId },
        create: { clubId, ...brandData(body.slot, publicUrl) },
        update: brandData(body.slot, publicUrl),
      }),
    );

    if (previous && previous !== publicUrl) await deleteIfOurs(previous);

    return NextResponse.json({ ok: true, url: publicUrl });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:branding");

    const body = await parseBody(request, removeSchema);
    const previous = await currentUrl(clubId, body.slot);

    await withOwnerRls({ type: "CLUB", clubId }, (tx) =>
      tx.brandSettings.updateMany({
        where: { clubId },
        data: brandData(body.slot, null),
      }),
    );
    if (previous) await deleteIfOurs(previous);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
