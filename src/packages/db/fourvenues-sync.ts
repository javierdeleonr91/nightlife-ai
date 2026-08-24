import { refreshIntervalSeconds } from "@nightlife/core/time";
import { withOwnerRls } from "./owner";
import { FourvenuesApiError } from "@nightlife/ticketing/fourvenues-api";
import type { NormalizedEvent } from "@nightlife/ticketing/types";
import { prisma } from "./client";
import { persistImportedEvent, refreshEventFromSource } from "./import";
import { clientFor, markSyncResult, markInvalid } from "./integrations";

/**
 * Sincronización con Fourvenues.
 *
 * Fourvenues es la fuente de verdad. Los eventos se crean allí; aquí solo se
 * guarda una copia para que la UI cargue rápido y para que la IA tenga algo
 * que leer sin llamar a la API en cada mensaje. Por eso el sentido es siempre
 * uno: de Fourvenues hacia nosotros. Nunca al revés.
 *
 * Un evento ya importado se **actualiza**, no se duplica: el enganche es
 * `EventSource.externalId`, el `_id` que da la propia API.
 */

export const FOURVENUES_PROVIDER = "fourvenues-api";

/** Una línea del informe: lo justo para pintar la tarjeta de un evento. */
export interface SyncedEvent {
  readonly id: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly imageUrl: string | null;
  readonly isNew: boolean;
}

export interface SyncReport {
  readonly ok: boolean;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly total: number;
  /** Mensaje apto para enseñar tal cual. Nunca técnico. */
  readonly message?: string;
  /**
   * Se declara readonly de cara afuera y se construye con un array mutable
   * dentro. Declarar readonly lo que estás llenando con push es mentir sobre
   * el propio código.
   */
  readonly events: readonly SyncedEvent[];
}

/**
 * Trae los eventos de la ventana pedida y los deja guardados.
 *
 * `dryRun` hace exactamente lo mismo sin escribir: es lo que alimenta la
 * pantalla de «8 events found» antes de que el club diga que sí.
 */
export async function syncFourvenues(args: {
  clubId: string;
  days?: number;
  dryRun?: boolean;
}): Promise<SyncReport> {
  const api = await clientFor(args.clubId);
  if (!api) {
    return {
      ok: false,
      created: 0,
      updated: 0,
      skipped: 0,
      total: 0,
      events: [],
      message: "Connect Fourvenues first.",
    };
  }

  const now = new Date();
  const end = new Date(now.getTime() + (args.days ?? 120) * 86_400_000);

  let incoming: NormalizedEvent[];
  try {
    // Ventana que empieza ayer: un evento que arrancó anoche a las 23:30 sigue
    // siendo la noche de hoy para quien pregunta a las 02:00.
    incoming = await api.listEvents({ start: new Date(now.getTime() - 86_400_000), end });
  } catch (error) {
    const code = error instanceof FourvenuesApiError ? error.code : "UPSTREAM";
    if (code === "INVALID_KEY") await markInvalid(args.clubId);
    else await markSyncResult({ clubId: args.clubId, errorCode: code });
    return {
      ok: false,
      created: 0,
      updated: 0,
      skipped: 0,
      total: 0,
      events: [],
      message:
        error instanceof FourvenuesApiError
          ? error.publicMessage
          : "We couldn't reach Fourvenues right now. Try again in a moment.",
    };
  }

  const existing = await withOwnerRls({ type: "CLUB", clubId: args.clubId }, (tx) =>
    tx.eventSource.findMany({
      where: { clubId: args.clubId, provider: FOURVENUES_PROVIDER },
      select: { eventId: true, externalId: true },
    }),
  );
  const byExternal = new Map(
    existing.filter((s) => s.externalId).map((s) => [s.externalId as string, s.eventId]),
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const report: SyncedEvent[] = [];

  for (const event of incoming) {
    const externalId = event.externalId;
    if (!externalId || !event.startsAt) {
      // Sin id o sin fecha no se puede ni enganchar ni mostrar. Se cuenta y se
      // dice, en vez de inventarle una fecha.
      skipped += 1;
      continue;
    }

    // La fecha se convierte una sola vez y aquí. A partir de esta línea es una
    // Date de verdad, así que abajo no hace falta ningún `!` para convencer al
    // compilador de algo que no había comprobado nadie.
    const startsAt = new Date(event.startsAt.value);
    if (Number.isNaN(startsAt.getTime())) {
      // Fourvenues mandó una fecha que no se puede leer. Saltar es lo correcto:
      // un evento con fecha inválida en la base de datos rompe el orden de la
      // agenda y el asistente acabaría diciendo una fecha imposible.
      skipped += 1;
      continue;
    }

    // Precios: una llamada más por evento. Vale la pena porque el precio es
    // justo lo que la gente pregunta.
    let withPrices = event;
    try {
      const rates = await api.listTicketRates(externalId);
      withPrices = api.withRates(event, rates);
    } catch {
      // Si las tarifas fallan, el evento entra igual sin precio. Mejor un
      // evento sin precio que ningún evento.
    }

    const knownId = byExternal.get(externalId);

    if (args.dryRun) {
      report.push({
        id: externalId,
        name: withPrices.name.value,
        startsAt,
        imageUrl: withPrices.imageUrl?.value ?? null,
        isNew: !knownId,
      });
      if (knownId) updated += 1;
      else created += 1;
      continue;
    }

    if (knownId) {
      await refreshEventFromSource(knownId, withPrices, args.clubId);
      await withOwnerRls({ type: "CLUB", clubId: args.clubId }, (tx) =>
        tx.eventSource.updateMany({
          where: { eventId: knownId, clubId: args.clubId },
          data: { lastSyncedAt: new Date(), syncStatus: "OK", lastError: null },
        }),
      );
      updated += 1;
      report.push({
        id: knownId,
        name: withPrices.name.value,
        startsAt,
        imageUrl: withPrices.imageUrl?.value ?? null,
        isNew: false,
      });
    } else {
      const { eventId } = await persistImportedEvent(withPrices, {
        clubId: args.clubId,
        provider: FOURVENUES_PROVIDER,
        sourceUrl: withPrices.sourceUrl,
      });
      await withOwnerRls({ type: "CLUB", clubId: args.clubId }, (tx) =>
        tx.eventSource.updateMany({
          where: { eventId, clubId: args.clubId },
          data: {
            externalId,
            refreshEverySeconds: refreshIntervalSeconds(startsAt) || 21_600,
          },
        }),
      );
      created += 1;
      report.push({
        id: eventId,
        name: withPrices.name.value,
        startsAt,
        imageUrl: withPrices.imageUrl?.value ?? null,
        isNew: true,
      });
    }
  }

  if (!args.dryRun) {
    await markSyncResult({ clubId: args.clubId, eventsSynced: created + updated });
  }

  return { ok: true, created, updated, skipped, total: incoming.length, events: report };
}
