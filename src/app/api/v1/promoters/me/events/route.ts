import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls, withPublicClubRls } from "@nightlife/db/owner";
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
    const promoterId = principal.promoterId;

    // Los eventos permitidos se leen club a club: el contexto de RLS es UN
    // club y aquí hay varios. Aunque el cliente mande cualquier id, aquí se
    // filtra contra la realidad — un id de un club donde no está aprobado
    // simplemente no aparece.
    const allowed = (
      await Promise.all(
        principal.promoterClubIds.map((clubId) =>
          withPublicClubRls(clubId, (tx) =>
            tx.event.findMany({
              where: { id: { in: body.eventIds }, clubId },
              select: { id: true, clubId: true },
            }),
          ),
        ),
      )
    ).flat();

    // La selección es del RRPP, así que se escribe en su contexto.
    await withOwnerRls({ type: "PROMOTER", promoterId }, async (tx) => {
      await tx.promoterEvent.deleteMany({
        where: { promoterId, eventId: { notIn: allowed.map((e) => e.id) } },
      });
      for (const event of allowed) {
        await tx.promoterEvent.upsert({
          where: { promoterId_eventId: { promoterId, eventId: event.id } },
          create: { promoterId, eventId: event.id, clubId: event.clubId },
          update: {},
        });
      }
    });

    return NextResponse.json({ selected: allowed.length, rejected: body.eventIds.length - allowed.length });
  } catch (error) {
    return apiError(error);
  }
}
