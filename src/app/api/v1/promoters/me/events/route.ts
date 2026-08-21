import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({ eventIds: z.array(z.string().min(1)).max(100) });

export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("No tienes perfil de promoter");

    const body = await parseBody(request, schema);

    // Solo eventos de clubs donde el alta está APROBADA. Aunque el cliente
    // mande cualquier id, aquí se filtra contra la realidad.
    const allowed = await prisma.event.findMany({
      where: { id: { in: body.eventIds }, clubId: { in: principal.promoterClubIds } },
      select: { id: true, clubId: true },
    });

    const promoterId = principal.promoterId;

    await prisma.$transaction([
      prisma.promoterEvent.deleteMany({
        where: { promoterId, eventId: { notIn: allowed.map((e) => e.id) } },
      }),
      ...allowed.map((event) =>
        prisma.promoterEvent.upsert({
          where: { promoterId_eventId: { promoterId, eventId: event.id } },
          create: { promoterId, eventId: event.id, clubId: event.clubId },
          update: {},
        }),
      ),
    ]);

    return NextResponse.json({ selected: allowed.length, rejected: body.eventIds.length - allowed.length });
  } catch (error) {
    return apiError(error);
  }
}
