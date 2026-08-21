import { z } from "zod";
import { NextResponse } from "next/server";
import { EXTRACTION_CONFIDENCE, type DataPoint } from "@nightlife/core/provenance";
import type { NormalizedEvent } from "@nightlife/ticketing/types";
import { assertPermission, forTenant, persistImportedEvent } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Paso 2 del import: el club firma.
 *
 * Los campos que la persona haya corregido en el preview se guardan con
 * source MANUAL y confianza 1, y a partir de ahí el refresh automático no los
 * pisa. Alguien se molestó en mirarlo: sabe más que el parser.
 */

const overrideSchema = z.object({
  name: z.string().min(1).optional(),
  startsAtIso: z.string().datetime({ offset: true }).optional(),
  currentPriceCents: z.number().int().min(0).optional(),
  nextPriceCents: z.number().int().min(0).optional(),
  djs: z.array(z.string().min(1)).optional(),
  ticketUrl: z.string().url().optional(),
});

const schema = z.object({
  clubId: z.string().min(1),
  /** El objeto devuelto por /fourvenues/import, tal cual. */
  raw: z.unknown(),
  overrides: overrideSchema.optional(),
});

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(request, schema);
    assertPermission(principal, body.clubId, "source:import");

    const normalized = reviveNormalizedEvent(body.raw, body.overrides);

    const { eventId } = await persistImportedEvent(normalized, {
      clubId: body.clubId,
      provider: "fourvenues-public",
      sourceUrl: normalized.sourceUrl,
    });

    const db = forTenant(principal, body.clubId);
    await db.audit("event.import.confirm", {
      eventId,
      sourceUrl: normalized.sourceUrl,
      overridden: Object.keys(body.overrides ?? {}),
    });

    return NextResponse.json({ eventId });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Las fechas viajan como string en JSON. Se reconstruyen los DataPoints y se
 * aplican las correcciones del club, marcándolas como MANUAL.
 */
function reviveNormalizedEvent(
  raw: unknown,
  overrides: z.infer<typeof overrideSchema> | undefined,
): NormalizedEvent {
  const source = raw as NormalizedEvent;
  const now = new Date();

  function revive<T>(dp: unknown): DataPoint<T> | null {
    if (!dp || typeof dp !== "object") return null;
    const d = dp as DataPoint<T> & { lastUpdated: string | Date };
    return { ...d, lastUpdated: new Date(d.lastUpdated) };
  }

  const manual = <T>(value: T, field: string, ttlSeconds: number) => ({
    value,
    source: "MANUAL" as const,
    confidence: EXTRACTION_CONFIDENCE.MANUAL_ENTRY,
    field,
    ttlSeconds,
    lastUpdated: now,
  });

  const event: NormalizedEvent = {
    ...source,
    name: overrides?.name ? manual(overrides.name, "eventName", 86_400) : revive(source.name)!,
    startsAt: overrides?.startsAtIso
      ? manual(overrides.startsAtIso, "startsAt", 86_400)
      : revive(source.startsAt),
    description: revive(source.description),
    imageUrl: revive(source.imageUrl),
    venueName: revive(source.venueName),
    dj: overrides?.djs ? manual(overrides.djs, "dj", 86_400) : revive(source.dj),
    ticketUrl: overrides?.ticketUrl
      ? manual(overrides.ticketUrl, "ticketUrl", 604_800)
      : revive(source.ticketUrl),
    currentPrice:
      overrides?.currentPriceCents !== undefined
        ? manual(overrides.currentPriceCents, "currentPrice", 600)
        : revive(source.currentPrice),
    nextPrice:
      overrides?.nextPriceCents !== undefined
        ? manual(overrides.nextPriceCents, "nextPrice", 600)
        : revive(source.nextPrice),
    availability: revive(source.availability)!,
    ticketTypes: (source.ticketTypes ?? []).map((t) => ({
      ...t,
      priceCents: revive(t.priceCents),
      status: revive(t.status)!,
    })),
  };

  // Si el club corrigió el precio y no había tipos de entrada, se crea uno:
  // así el evento queda vendible aunque la fuente no diera nada.
  if (overrides?.currentPriceCents !== undefined && event.ticketTypes.length === 0) {
    return {
      ...event,
      ticketTypes: [
        {
          name: "Entrada",
          sortOrder: 0,
          priceCents: manual(overrides.currentPriceCents, "ticketTypePrice", 600),
          status: manual("AVAILABLE" as const, "ticketTypeStatus", 300),
        },
      ],
    };
  }

  return event;
}
