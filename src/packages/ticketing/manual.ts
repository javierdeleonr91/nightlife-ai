/**
 * ManualSource — el plan B que siempre funciona.
 *
 * No es un fallback de segunda: es la garantía de que el producto sigue
 * vendiendo el día que la fuente externa cambie, bloquee o desaparezca. Un
 * club puede operar entero con esta fuente. Los datos introducidos por una
 * persona tienen confianza 1 y TTL largo, porque nadie los cambia a nuestras
 * espaldas.
 */

import { DEFAULT_TTL_SECONDS, EXTRACTION_CONFIDENCE, dataPoint } from "@nightlife/core/provenance";
import type {
  AvailabilityState,
  EventRef,
  NormalizedEvent,
  NormalizedTicketType,
  ProviderCapabilities,
  TicketingProvider,
} from "./types";

export const MANUAL_CAPABILITIES: ProviderCapabilities = {
  id: "manual",
  label: "Introducido por el club",
  supportsEventLookup: false,
  supportsTicketTypes: true,
  supportsCurrentPrice: true,
  supportsAvailability: false,
  minRequestIntervalMs: 0,
};

export interface ManualEventInput {
  readonly name: string;
  readonly startsAtIso: string;
  readonly ticketUrl: string;
  readonly currentPriceCents?: number;
  readonly nextPriceCents?: number;
  readonly djs?: readonly string[];
  readonly description?: string;
  readonly imageUrl?: string;
  readonly soldOut?: boolean;
}

export class ManualSource implements TicketingProvider {
  readonly capabilities = MANUAL_CAPABILITIES;

  constructor(private readonly input: ManualEventInput, private readonly now: Date = new Date()) {}

  async getEvent(_ref: EventRef): Promise<NormalizedEvent> {
    return this.build();
  }

  async getEvents(): Promise<readonly NormalizedEvent[]> {
    return [this.build()];
  }

  getCheckoutUrl(_ref: EventRef): string | null {
    try {
      return new URL(this.input.ticketUrl).toString();
    } catch {
      return null;
    }
  }

  private build(): NormalizedEvent {
    const i = this.input;
    const dp = <T>(value: T, field: string, ttl: number) =>
      dataPoint({
        value,
        source: "MANUAL" as const,
        confidence: EXTRACTION_CONFIDENCE.MANUAL_ENTRY,
        field,
        ttlSeconds: ttl,
        lastUpdated: this.now,
      });

    const availabilityState: AvailabilityState = i.soldOut
      ? "SOLD_OUT"
      : i.currentPriceCents !== undefined
        ? "AVAILABLE"
        : "UNKNOWN";

    const ticketTypes: NormalizedTicketType[] = [];
    if (i.currentPriceCents !== undefined) {
      ticketTypes.push({
        name: "Entrada",
        sortOrder: 0,
        priceCents: dp(i.currentPriceCents, "ticketTypePrice", DEFAULT_TTL_SECONDS.currentPrice),
        status: dp(availabilityState, "ticketTypeStatus", DEFAULT_TTL_SECONDS.availability),
      });
    }

    return {
      sourceUrl: i.ticketUrl,
      name: dp(i.name, "eventName", DEFAULT_TTL_SECONDS.eventName),
      startsAt: dp(i.startsAtIso, "startsAt", DEFAULT_TTL_SECONDS.startsAt),
      venueName: null,
      description: i.description ? dp(i.description, "description", DEFAULT_TTL_SECONDS.description) : null,
      imageUrl: i.imageUrl ? dp(i.imageUrl, "imageUrl", DEFAULT_TTL_SECONDS.imageUrl) : null,
      dj: i.djs && i.djs.length > 0 ? dp([...i.djs], "dj", DEFAULT_TTL_SECONDS.dj) : null,
      ticketUrl: dp(i.ticketUrl, "ticketUrl", DEFAULT_TTL_SECONDS.ticketUrl),
      ticketTypes,
      currentPrice:
        i.currentPriceCents !== undefined && !i.soldOut
          ? dp(i.currentPriceCents, "currentPrice", DEFAULT_TTL_SECONDS.currentPrice)
          : null,
      nextPrice:
        i.nextPriceCents !== undefined ? dp(i.nextPriceCents, "nextPrice", DEFAULT_TTL_SECONDS.nextPrice) : null,
      availability: dp(availabilityState, "availability", DEFAULT_TTL_SECONDS.availability),
      missingFields: [],
      warnings: [],
    };
  }
}
