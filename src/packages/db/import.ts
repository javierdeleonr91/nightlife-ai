import { AppError } from "@nightlife/core/errors";
import { slugify } from "@nightlife/core/slug";
import { refreshIntervalSeconds } from "@nightlife/core/time";
import { MIN_CONFIDENCE_TO_STORE } from "@nightlife/core/provenance";
import type { NormalizedEvent } from "@nightlife/ticketing/types";
import { withOwnerRls } from "./owner";

/**
 * Persistencia del import y del refresh.
 *
 * Dos reglas que evitan los dos fallos caros:
 *
 *  1. Un precio nunca se sobrescribe. Se cierra el vigente y se abre otro.
 *     Sin esto no se puede responder "¿cuánto costaba?" sin inventar, y
 *     tampoco se puede auditar por qué el bot dijo lo que dijo.
 *  2. Un campo corregido a mano por el club (source MANUAL) no lo pisa el
 *     refresh automático. Si una persona se molestó en corregirlo, sabe más
 *     que el parser.
 */

export interface PersistOptions {
  readonly clubId: string;
  readonly provider: string;
  readonly sourceUrl: string;
  /** Campos que el club editó en el preview: quedan blindados frente al sync. */
  readonly manualOverrides?: Record<string, unknown>;
}

export async function persistImportedEvent(
  normalized: NormalizedEvent,
  options: PersistOptions,
): Promise<{ eventId: string }> {
  const startsAtIso = normalized.startsAt?.value;
  if (!startsAtIso) {
    throw AppError.validation("El evento no tiene fecha. Añádela antes de confirmar.");
  }
  const startsAt = new Date(startsAtIso);
  if (Number.isNaN(startsAt.getTime())) {
    throw AppError.validation("La fecha del evento no es válida");
  }

  const name = normalized.name.value;
  const baseSlug = slugify(name) || "evento";

  // Con el club fijado: todo lo que se escribe aquí —evento, tarifas,
  // precios, data points— está bajo RLS.
  return withOwnerRls({ type: "CLUB", clubId: options.clubId }, async (tx) => {
    // Slug único dentro del club, no global: dos clubs pueden tener su
    // "summer-closing" sin pisarse.
    let slug = baseSlug;
    for (let i = 1; i < 50; i++) {
      const clash = await tx.event.findUnique({
        where: { clubId_slug: { clubId: options.clubId, slug } },
      });
      if (!clash) break;
      slug = `${baseSlug}-${i}`;
    }

    const event = await tx.event.create({
      data: {
        clubId: options.clubId,
        name,
        slug,
        description: normalized.description?.value ?? null,
        startsAt,
        djLineup:
          normalized.dj && normalized.dj.confidence >= MIN_CONFIDENCE_TO_STORE
            ? normalized.dj.value
            : [],
        imageUrl: normalized.imageUrl?.value ?? null,
        ticketUrl: normalized.ticketUrl?.value ?? null,
        status: "ACTIVE",
      },
    });

    await tx.eventSource.create({
      data: {
        eventId: event.id,
        clubId: options.clubId,
        provider: options.provider,
        sourceUrl: options.sourceUrl,
        lastSyncedAt: new Date(),
        syncStatus: "OK",
        refreshEverySeconds: refreshIntervalSeconds(startsAt) || 21_600,
      },
    });

    for (const type of normalized.ticketTypes) {
      const created = await tx.ticketType.create({
        data: {
          eventId: event.id,
          clubId: options.clubId,
          name: type.name,
          sortOrder: type.sortOrder,
          status:
            type.status.value === "AVAILABLE"
              ? "AVAILABLE"
              : type.status.value === "SOLD_OUT"
                ? "SOLD_OUT"
                : "UNKNOWN",
        },
      });
      if (type.priceCents) {
        await tx.ticketPrice.create({
          data: {
            ticketTypeId: created.id,
            clubId: options.clubId,
            amountCents: type.priceCents.value,
            isCurrent: true,
            source: type.priceCents.source,
            confidence: type.priceCents.confidence,
          },
        });
      }
    }

    return { eventId: event.id };
  });
}

/**
 * Refresh de un evento ya importado. Solo toca lo que cambió, y respeta lo
 * que el club haya fijado a mano.
 */
/**
 * `clubId` es obligatorio desde app-04, y no es burocracia: es lo que fija el
 * contexto de RLS de la transacción. Sin él, con `nl_app` el `findUnique` de
 * abajo devolvería null y la función diría «el evento no existe» sobre un
 * evento que existe.
 *
 * El llamante ya lo tiene siempre: la ruta lo valida contra el club del
 * usuario y el worker lo saca del propio `event_source`.
 */
export async function refreshEventFromSource(
  eventId: string,
  normalized: NormalizedEvent,
  clubId: string,
): Promise<{ pricesChanged: number }> {
  return withOwnerRls({ type: "CLUB", clubId }, async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
    });
    if (!event) throw AppError.notFound("Evento");

    let pricesChanged = 0;

    for (const incoming of normalized.ticketTypes) {
      const existing = event.ticketTypes.find((t) => t.name === incoming.name);
      const nextStatus =
        incoming.status.value === "AVAILABLE"
          ? "AVAILABLE"
          : incoming.status.value === "SOLD_OUT"
            ? "SOLD_OUT"
            : "UNKNOWN";

      if (!existing) {
        const created = await tx.ticketType.create({
          data: {
            eventId,
            clubId: event.clubId,
            name: incoming.name,
            sortOrder: incoming.sortOrder,
            status: nextStatus,
          },
        });
        if (incoming.priceCents) {
          await tx.ticketPrice.create({
            data: {
              ticketTypeId: created.id,
              clubId: event.clubId,
              amountCents: incoming.priceCents.value,
              source: incoming.priceCents.source,
              confidence: incoming.priceCents.confidence,
            },
          });
          pricesChanged += 1;
        }
        continue;
      }

      await tx.ticketType.update({ where: { id: existing.id }, data: { status: nextStatus } });

      const current = existing.prices[0];
      // Un precio puesto a mano gana al que venga de la fuente.
      if (current?.source === "MANUAL") continue;

      if (incoming.priceCents && current?.amountCents !== incoming.priceCents.value) {
        if (current) {
          await tx.ticketPrice.update({
            where: { id: current.id },
            data: { isCurrent: false, validTo: new Date() },
          });
        }
        await tx.ticketPrice.create({
          data: {
            ticketTypeId: existing.id,
            clubId: event.clubId,
            amountCents: incoming.priceCents.value,
            source: incoming.priceCents.source,
            confidence: incoming.priceCents.confidence,
          },
        });
        pricesChanged += 1;
      }
    }

    const allSoldOut =
      normalized.ticketTypes.length > 0 &&
      normalized.ticketTypes.every((t) => t.status.value === "SOLD_OUT");

    await tx.event.update({
      where: { id: eventId },
      data: {
        status: allSoldOut ? "SOLD_OUT" : event.status === "SOLD_OUT" ? "ACTIVE" : event.status,
        ...(normalized.ticketUrl ? { ticketUrl: normalized.ticketUrl.value } : {}),
      },
    });

    await tx.eventSource.update({
      where: { eventId },
      data: {
        lastSyncedAt: new Date(),
        syncStatus: "OK",
        lastError: null,
        refreshEverySeconds: refreshIntervalSeconds(event.startsAt) || 21_600,
      },
    });

    return { pricesChanged };
  });
}
