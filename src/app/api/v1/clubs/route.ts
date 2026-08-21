import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { slugify, validateSlug, suggestSlugs } from "@nightlife/core/slug";
import { startTrial, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { env } from "@nightlife/config/env";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({
  name: z.string().min(2).max(80),
  city: z.string().min(2).max(80),
  slug: z.string().min(3).max(48).optional(),
  instagram: z.string().max(60).optional(),
  whatsapp: z.string().max(30).optional(),
  address: z.string().max(200).optional(),
  minAge: z.number().int().min(16).max(30).optional(),
});

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(request, schema);

    const slug = body.slug ?? slugify(body.name);
    const problem = validateSlug(slug);
    if (problem) {
      const taken = new Set(
        (await prisma.club.findMany({ select: { slug: true } })).map((c) => c.slug),
      );
      throw AppError.validation(
        problem === "RESERVED"
          ? `"${slug}" está reservado. Prueba con: ${suggestSlugs(body.name, taken).join(", ")}`
          : "El identificador no es válido: usa minúsculas, números y guiones",
      );
    }
    if (await prisma.club.findUnique({ where: { slug } })) {
      const taken = new Set(
        (await prisma.club.findMany({ select: { slug: true } })).map((c) => c.slug),
      );
      throw new AppError(
        "CONFLICT",
        `Ese identificador ya existe. Prueba con: ${suggestSlugs(body.name, taken).join(", ")}`,
      );
    }

    // Crear el club, hacerte owner y dejarlo operativo va en una transacción:
    // un club sin owner sería un recurso al que nadie puede entrar.
    const club = await prisma.$transaction(async (tx) => {
      const created = await tx.club.create({
        data: {
          slug,
          name: body.name.trim(),
          city: body.city.trim(),
          instagram: body.instagram ?? null,
          whatsapp: body.whatsapp ?? null,
          address: body.address ?? null,
          minAge: body.minAge ?? null,
        },
      });
      await tx.clubMember.create({
        data: { userId: principal.userId, clubId: created.id, role: "CLUB_OWNER" },
      });
      await tx.brandSettings.create({ data: { clubId: created.id } });
      await tx.aiConfig.create({
        data: { clubId: created.id, dailyBudgetCents: env().DEFAULT_AI_DAILY_BUDGET_CENTS },
      });
      // FAQ por defecto a partir de lo que el club acaba de escribir: el
      // onboarding no obliga a redactarlas y el bot ya responde algo útil.
      if (body.address) {
        await tx.fAQ.create({
          data: {
            clubId: created.id,
            question: "¿Dónde estáis?",
            answer: `Estamos en ${body.address}, ${body.city}.`,
            keywords: ["donde", "direccion", "ubicacion", "llegar"],
          },
        });
      }
      if (body.minAge) {
        await tx.fAQ.create({
          data: {
            clubId: created.id,
            question: "¿Qué edad mínima hay?",
            answer: `Mínimo ${body.minAge} años, con DNI o pasaporte.`,
            keywords: ["edad", "años", "menores", "dni"],
          },
        });
      }
      await tx.auditLog.create({
        data: { actorId: principal.userId, clubId: created.id, action: "club.create" },
      });
      return created;
    });

    // El club es cliente de software: arranca su periodo de prueba. Nada de
    // esto tiene que ver con las entradas, que cobra Fourvenues.
    await startTrial("CLUB", club.id);

    return NextResponse.json({ id: club.id, slug: club.slug, name: club.name });
  } catch (error) {
    return apiError(error);
  }
}
