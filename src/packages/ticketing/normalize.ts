/**
 * Normalización: de datos crudos a un NormalizedEvent con procedencia.
 *
 * Aquí vive la regla más importante del producto: **cuál es el precio de ahora
 * mismo**. Una fiesta con Early Bird 15 € agotado, 1st Release 18 € agotado y
 * 2nd Release 20 € disponible cuesta 20 €. Decir 15 € porque es el primero de
 * la lista es el error que hace que un club deje de fiarse del bot.
 */

import {
  DEFAULT_TTL_SECONDS,
  EXTRACTION_CONFIDENCE,
  dataPoint,
  type DataPoint,
} from "@nightlife/core/provenance";
import { parseMoneyToCents } from "@nightlife/core/money";
import type { AvailabilityState, NormalizedEvent, NormalizedTicketType } from "./types";
import { guessDjsFromTitle, type RawEventData, type RawOffer } from "./parse";

const SCHEMA_AVAILABILITY: Record<string, AvailabilityState> = {
  instock: "AVAILABLE",
  onlineonly: "AVAILABLE",
  limitedavailability: "AVAILABLE",
  presale: "AVAILABLE",
  soldout: "SOLD_OUT",
  outofstock: "SOLD_OUT",
  discontinued: "SOLD_OUT",
  preorder: "UNKNOWN",
  backorder: "UNKNOWN",
};

function availabilityFromSchema(raw: string | undefined): AvailabilityState {
  if (!raw) return "UNKNOWN";
  const key = raw.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/[^a-z]/g, "");
  return SCHEMA_AVAILABILITY[key] ?? "UNKNOWN";
}

function offerCents(offer: RawOffer): number | null {
  if (typeof offer.price === "number") {
    return Number.isFinite(offer.price) ? Math.round(offer.price * 100) : null;
  }
  if (typeof offer.price === "string") return parseMoneyToCents(offer.price);
  return null;
}

export interface NormalizeOptions {
  readonly sourceUrl: string;
  readonly now?: Date;
  /** Se pasa a los DataPoints. Solo la API oficial debería usar 1.0. */
  readonly baseConfidence?: number;
}

export function normalizeEvent(raw: RawEventData, options: NormalizeOptions): NormalizedEvent {
  const now = options.now ?? new Date();
  const confidence = options.baseConfidence ?? raw.confidence;
  const source = "FOURVENUES" as const;
  const missing: string[] = [];
  const warnings: string[] = [];

  const dp = <T>(value: T, field: string, ttl: number, conf = confidence): DataPoint<T> =>
    dataPoint({ value, source, confidence: conf, field, ttlSeconds: ttl, lastUpdated: now });

  // ── tipos de entrada ────────────────────────────────────────────────
  const ticketTypes: NormalizedTicketType[] = raw.offers.map((offer, index) => {
    const cents = offerCents(offer);
    const status = availabilityFromSchema(offer.availability);
    const type: NormalizedTicketType = {
      name: offer.name ?? `Entrada ${index + 1}`,
      sortOrder: index,
      priceCents: cents === null ? null : dp(cents, "ticketTypePrice", DEFAULT_TTL_SECONDS.currentPrice),
      status: dp(status, "ticketTypeStatus", DEFAULT_TTL_SECONDS.availability),
    };
    return type;
  });

  // ── precio vigente ──────────────────────────────────────────────────
  const priced = ticketTypes
    .map((t) => ({ t, cents: t.priceCents?.value ?? null }))
    .filter((x): x is { t: NormalizedTicketType; cents: number } => x.cents !== null);

  const available = priced.filter((x) => x.t.status.value === "AVAILABLE");
  const soldOut = priced.filter((x) => x.t.status.value === "SOLD_OUT");
  const unknownStatus = priced.filter((x) => x.t.status.value === "UNKNOWN");

  let currentPrice: DataPoint<number> | null = null;
  let nextPrice: DataPoint<number> | null = null;

  if (available.length > 0) {
    // La escalera de releases sube: el vigente es el más barato de los que
    // todavía se pueden comprar.
    const sorted = [...available].sort((a, b) => a.cents - b.cents);
    const current = sorted[0] as { t: NormalizedTicketType; cents: number };
    currentPrice = dp(current.cents, "currentPrice", DEFAULT_TTL_SECONDS.currentPrice);

    const higher = priced
      .filter((x) => x.cents > current.cents)
      .sort((a, b) => a.cents - b.cents)[0];
    if (higher) {
      nextPrice = dp(higher.cents, "nextPrice", DEFAULT_TTL_SECONDS.nextPrice);
    }
  } else if (priced.length > 0 && unknownStatus.length === priced.length) {
    // La fuente da precios pero no dice cuál está activo. Guardamos el más
    // probable con confianza rebajada: por debajo del umbral para afirmar,
    // así que el bot NO lo dirá. Aparece en el preview para que el club lo
    // confirme a mano, y al confirmarlo pasa a MANUAL con confianza 1.
    const cheapest = [...priced].sort((a, b) => a.cents - b.cents)[0] as {
      t: NormalizedTicketType;
      cents: number;
    };
    currentPrice = dp(
      cheapest.cents,
      "currentPrice",
      DEFAULT_TTL_SECONDS.currentPrice,
      Math.min(confidence, EXTRACTION_CONFIDENCE.OPEN_GRAPH),
    );
    warnings.push(
      "La fuente no indica qué release está activo. El precio detectado no se usará en las respuestas hasta que lo confirmes.",
    );
  } else if (priced.length > 0 && soldOut.length === priced.length) {
    warnings.push("Todos los tipos de entrada aparecen agotados en la fuente.");
  } else {
    missing.push("currentPrice");
  }

  // ── disponibilidad ──────────────────────────────────────────────────
  // Solo tres estados, y nunca un número. No sabemos cuántas quedan y
  // afirmarlo sería inventar.
  let availabilityState: AvailabilityState = "UNKNOWN";
  if (available.length > 0) availabilityState = "AVAILABLE";
  else if (priced.length > 0 && soldOut.length === priced.length) availabilityState = "SOLD_OUT";

  const availability = dp(
    availabilityState,
    "availability",
    DEFAULT_TTL_SECONDS.availability,
    availabilityState === "UNKNOWN" ? 0 : confidence,
  );

  // ── resto de campos ─────────────────────────────────────────────────
  const startsAt = raw.startDate ? dp(raw.startDate, "startsAt", DEFAULT_TTL_SECONDS.startsAt) : null;
  if (!startsAt) missing.push("startsAt");

  const ticketUrlValue = raw.offers.find((o) => o.url)?.url ?? raw.url ?? options.sourceUrl;
  const ticketUrl = ticketUrlValue
    ? dp(ticketUrlValue, "ticketUrl", DEFAULT_TTL_SECONDS.ticketUrl)
    : null;
  if (!ticketUrl) missing.push("ticketUrl");

  let dj: DataPoint<string[]> | null = null;
  if (raw.performers && raw.performers.length > 0) {
    dj = dp(raw.performers, "dj", DEFAULT_TTL_SECONDS.dj);
  } else {
    const guessed = guessDjsFromTitle(raw.name ?? "");
    if (guessed.length > 0) {
      // Adivinado del título: confianza de heurística. Nunca se afirma solo;
      // se propone en el preview para que una persona lo valide.
      dj = dp(guessed, "dj", DEFAULT_TTL_SECONDS.dj, EXTRACTION_CONFIDENCE.HEURISTIC_HTML);
      warnings.push("El cartel se ha deducido del título del evento. Revísalo antes de confirmar.");
    } else {
      missing.push("dj");
    }
  }

  const description = raw.description
    ? dp(raw.description, "description", DEFAULT_TTL_SECONDS.description)
    : null;
  if (!description) missing.push("description");

  const imageUrl = raw.image ? dp(raw.image, "imageUrl", DEFAULT_TTL_SECONDS.imageUrl) : null;
  if (!imageUrl) missing.push("imageUrl");

  const venueName = raw.locationName
    ? dp(raw.locationName, "venueName", DEFAULT_TTL_SECONDS.clubInfo)
    : null;

  if (ticketTypes.length === 0) {
    missing.push("ticketTypes");
    warnings.push("No se han encontrado tipos de entrada en la página pública.");
  }

  return {
    sourceUrl: options.sourceUrl,
    name: dp(raw.name ?? "Evento sin título", "eventName", DEFAULT_TTL_SECONDS.eventName),
    startsAt,
    venueName,
    description,
    imageUrl,
    dj,
    ticketUrl,
    ticketTypes,
    currentPrice,
    nextPrice,
    availability,
    missingFields: missing,
    warnings,
  };
}
