/**
 * El contexto que recibe el motor.
 *
 * El motor de IA NO hace red y NO consulta la base de datos. Recibe esto ya
 * resuelto por la capa de retrieval. Es lo que hace que "no inventar" sea una
 * propiedad del sistema y no una esperanza: si un dato no está en este objeto,
 * para la IA no existe.
 */

import type { DataPoint } from "@nightlife/core/provenance";
import type { AvailabilityState } from "@nightlife/ticketing/types";
import type { Intent } from "./intents";

export interface ClubContext {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly timezone: string;
  readonly address?: string | null;
  readonly minAge?: number | null;
  readonly dressCode?: string | null;
  readonly openingHours?: string | null;
  readonly policies?: string | null;
  readonly whatsapp?: string | null;
  readonly instagram?: string | null;
}

export interface EventContext {
  readonly id: string;
  readonly name: DataPoint<string>;
  readonly startsAt: DataPoint<string> | null;
  readonly djs: DataPoint<string[]> | null;
  readonly currentPrice: DataPoint<number> | null;
  readonly nextPrice: DataPoint<number> | null;
  readonly availability: DataPoint<AvailabilityState> | null;
  readonly ticketUrl: DataPoint<string> | null;
  readonly historicalPricesCents: readonly number[];
  readonly status: "ACTIVE" | "PAUSED" | "SOLD_OUT" | "ENDED" | "ERROR" | "SYNCING";
}

export interface VipContext {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number | null;
  readonly minPax: number;
  readonly maxPax: number;
  readonly includes: readonly string[];
  readonly bookingContact?: string | null;
}

export interface FaqContext {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly keywords: readonly string[];
}

export interface HistoryTurn {
  readonly role: "CUSTOMER" | "ASSISTANT";
  readonly content: string;
  readonly intent?: Intent | null;
}

export interface PromoterContext {
  readonly id: string;
  readonly displayName: string;
  /**
   * Etiqueta que se añade al enlace de checkout para que la ticketera del
   * club vea el origen. No la leemos de vuelta ni calculamos nada con ella.
   */
  readonly referralTag?: string | null;
}

export interface ConversationContext {
  readonly club: ClubContext;
  /** El evento del que se está hablando. Null si aún no se ha fijado. */
  readonly event: EventContext | null;
  /** Otros eventos próximos, para desambiguar. Sin datos de precio: solo nombre y fecha. */
  readonly upcomingEvents: readonly { id: string; name: string; startsAtIso: string }[];
  readonly vipOptions: readonly VipContext[];
  readonly faqs: readonly FaqContext[];
  readonly history: readonly HistoryTurn[];
  readonly promoter: PromoterContext | null;
  readonly partySize: number | null;
  readonly lastIntent: Intent | null;
  readonly locale: string;
  readonly now: Date;
}
