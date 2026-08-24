import { z } from "zod";
import { withOwnerRls } from "@nightlife/db/owner";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { FourvenuesPublicSource } from "@nightlife/ticketing";
import {
  assertPermission,
  refreshEventFromSource,
  unsafePrismaForMigrationsOnly as prisma,
} from "@nightlife/db";
import { env } from "@nightlife/config/env";
import { apiError, parseBody, rateLimit } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({ clubId: z.string().min(1) });

/**
 * Refresh manual desde el detalle del evento.
 *
 * Con throttle por evento, no por usuario: el botón está a la vista y alguien
 * lo va a pulsar cinco veces seguidas mirando si sube el precio. Eso no puede
 * convertirse en cinco peticiones a la fuente.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(request, schema);
    const { eventId } = await params;
    assertPermission(principal, body.clubId, "source:refresh");

    rateLimit(`refresh:${eventId}`, 4, 60);

    const event = await withOwnerRls({ type: "CLUB", clubId: body.clubId }, (tx) =>
      tx.event.findFirst({
        where: { id: eventId, clubId: body.clubId },
        include: { source: true },
      }),
    );
    if (!event) throw AppError.notFound("Evento");

    if (!event.source?.sourceUrl || event.source.provider === "manual") {
      throw AppError.validation("Este evento no viene de una fuente externa: edítalo a mano.");
    }
    if (event.source.syncStatus === "UNSUPPORTED") {
      throw new AppError(
        "SOURCE_FORBIDDEN",
        "La fuente ha bloqueado la lectura de este evento. Actualiza los datos a mano.",
      );
    }

    const provider = new FourvenuesPublicSource({
      contactUrl: env().SOURCE_CONTACT_URL,
      minRequestIntervalMs: env().SOURCE_MIN_INTERVAL_MS,
    });
    const normalized = await provider.getEvent({ url: event.source.sourceUrl });
    const { pricesChanged } = await refreshEventFromSource(event.id, normalized, body.clubId);

    return NextResponse.json({ pricesChanged });
  } catch (error) {
    return apiError(error);
  }
}
