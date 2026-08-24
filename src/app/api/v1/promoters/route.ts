import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { needsName } from "@nightlife/core/oauth";
import { slugify, suggestSlugs, validateSlug } from "@nightlife/core/slug";
import { startTrial, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({
  displayName: z.string().min(2).max(60),
  slug: z.string().min(3).max(48).optional(),
  city: z.string().max(60).optional(),
  bio: z.string().max(280).optional(),
  instagram: z.string().max(60).optional(),
  whatsapp: z.string().max(30).optional(),
  /** Club al que se solicita alta. Queda PENDING hasta que el club apruebe. */
  clubSlug: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(request, schema);

    if (principal.promoterId) throw new AppError("CONFLICT", "Ya tienes un perfil de promoter");

    const slug = body.slug ?? slugify(body.displayName);
    const problem = validateSlug(slug);
    const taken = new Set(
      (await prisma.promoter.findMany({ select: { slug: true } })).map((p) => p.slug),
    );
    // El link vive en la raíz (/alex), así que el espacio de nombres es global
    // y se comparte con las rutas del sistema.
    if (problem || taken.has(slug)) {
      throw AppError.validation(
        `Ese link no está disponible. Prueba con: ${suggestSlugs(body.displayName, taken).join(", ")}`,
      );
    }

    const promoter = await prisma.promoter.create({
      data: {
        userId: principal.userId,
        slug,
        displayName: body.displayName.trim(),
        city: body.city ?? null,
        bio: body.bio ?? null,
        instagram: body.instagram ?? null,
        whatsapp: body.whatsapp ?? null,
      },
    });

    if (body.clubSlug) {
      const club = await prisma.club.findUnique({ where: { slug: body.clubSlug } });
      // Sin aprobación del club, cualquiera podría montar un escaparate con
      // su marca. La solicitud nace PENDING siempre.
      if (club) {
        // La solicitud la crea el RRPP, así que el contexto es el suyo: con
        // la política de dos caras de la migración 011, el WITH CHECK la
        // acepta por el lado del promoter.
        await withOwnerRls({ type: "PROMOTER", promoterId: promoter.id }, (tx) =>
          tx.promoterClub.create({
            data: { promoterId: promoter.id, clubId: club.id, status: "PENDING" },
          }),
        );
      }
    }

    /*
     * §6: el rol se guarda una vez y no se vuelve a preguntar.
     *
     * Y si la cuenta llegó sin nombre — Apple solo lo manda en la primera
     * autorización, y a veces ni eso — se rellena aquí con el que acaba de
     * escribir. A partir de este momento el nombre es NUESTRO: los siguientes
     * accesos con Apple ya no dependen de que él lo vuelva a enviar.
     */
    const account = await prisma.user.findUnique({
      where: { id: principal.userId },
      select: { name: true },
    });
    await prisma.user.update({
      where: { id: principal.userId },
      data: {
        accountType: "PROMOTER",
        ...(needsName({ name: account?.name ?? null })
          ? { name: promoter.displayName }
          : {}),
      },
    });

    // El promoter paga por la herramienta, no cobra de nosotros: se le abre
    // una suscripción de software en periodo de prueba.
    await startTrial("PROMOTER", promoter.id);

    return NextResponse.json({ id: promoter.id, slug: promoter.slug });
  } catch (error) {
    return apiError(error);
  }
}
