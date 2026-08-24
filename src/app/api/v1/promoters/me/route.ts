import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { validateSlug } from "@nightlife/core/slug";
import { normalizePromoterLink } from "@nightlife/core/checkout";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({
  displayName: z.string().min(2).max(60).nullish(),
  slug: z.string().min(3).max(48).nullish(),
  bio: z.string().max(280).nullish(),
  city: z.string().max(60).nullish(),
  photoUrl: z.string().url().nullish(),
  instagram: z.string().max(60).nullish(),
  whatsapp: z.string().max(30).nullish(),
  fourvenuesUrl: z.string().max(500).nullish(),
  coverImageUrl: z.string().url().nullish(),
  showInstagram: z.boolean().optional(),
  showWhatsapp: z.boolean().optional(),
  showCity: z.boolean().optional(),
  onboardingStep: z.number().int().min(0).max(20).optional(),
});

export async function PATCH(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("You don't have a promoter profile");

    const body = await parseBody(request, schema);
    const data: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      // displayName no se puede vaciar; el resto sí.
      if (key === "displayName" && (value == null || value === "")) continue;
      if (key === "slug") continue; // se valida aparte
      if (key === "fourvenuesUrl") continue; // se valida aparte
      data[key] = value;
    }

    // Cambiar el slug rompe todos los enlaces que ya circulan por WhatsApp e
    // Instagram, así que se valida igual que al crearlo y se avisa en la UI.
    if (typeof body.slug === "string" && body.slug.length > 0) {
      const problem = validateSlug(body.slug);
      if (problem) throw AppError.validation("That link isn't available.");
      const taken = await prisma.promoter.findFirst({
        where: { slug: body.slug, NOT: { id: principal.promoterId } },
        select: { id: true },
      });
      if (taken) throw new AppError("CONFLICT", "That link is already taken.");
      data.slug = body.slug;
    }

    // El link de Fourvenues se acepta tal cual o no se acepta. Nunca se
    // "arregla" añadiéndole o quitándole nada.
    if (body.fourvenuesUrl !== undefined) {
      if (body.fourvenuesUrl == null || body.fourvenuesUrl === "") {
        data.fourvenuesUrl = null;
      } else {
        const link = normalizePromoterLink(body.fourvenuesUrl);
        if (!link) {
          throw AppError.validation(
            "That doesn't look like a Fourvenues link. Copy it from Fourvenues and paste it whole.",
          );
        }
        data.fourvenuesUrl = link;
      }
    }

    const promoter = await prisma.promoter.update({
      where: { id: principal.promoterId },
      data,
    });
    return NextResponse.json({ id: promoter.id, slug: promoter.slug });
  } catch (error) {
    return apiError(error);
  }
}
