import type { DataPoint } from "@nightlife/core/provenance";

/**
 * Contrato de ticketera.
 *
 * Todo lo que sabemos de un evento externo pasa por aquí. La clave del diseño
 * es `capabilities`: una fuente declara qué NO sabe hacer, esa incapacidad se
 * propaga al FactSet y el validador bloquea cualquier respuesta que afirme
 * algo que la fuente no puede saber. La ignorancia de la fuente llega hasta
 * la boca del bot en lugar de rellenarse con una suposición.
 */

export interface ProviderCapabilities {
  readonly id: string;
  readonly label: string;
  readonly supportsEventLookup: boolean;
  readonly supportsTicketTypes: boolean;
  readonly supportsCurrentPrice: boolean;
  /** Casi siempre false en fuente pública. Por eso el bot nunca dice cuántas quedan. */
  readonly supportsAvailability: boolean;
  /** Segundos mínimos entre peticiones a la fuente. Se respeta siempre. */
  readonly minRequestIntervalMs: number;
}

export type AvailabilityState = "AVAILABLE" | "SOLD_OUT" | "UNKNOWN";

export interface NormalizedTicketType {
  readonly externalId?: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly priceCents: DataPoint<number> | null;
  readonly status: DataPoint<AvailabilityState>;
}

export interface NormalizedEvent {
  readonly externalId?: string;
  readonly sourceUrl: string;
  readonly name: DataPoint<string>;
  readonly startsAt: DataPoint<string> | null; // ISO 8601
  readonly venueName: DataPoint<string> | null;
  readonly description: DataPoint<string> | null;
  readonly imageUrl: DataPoint<string> | null;
  readonly dj: DataPoint<string[]> | null;
  readonly ticketUrl: DataPoint<string> | null;
  readonly ticketTypes: readonly NormalizedTicketType[];
  /** El release vigente: el más barato disponible, no el primero de la lista. */
  readonly currentPrice: DataPoint<number> | null;
  /** El siguiente escalón, para poder decir "sube a 25 €". */
  readonly nextPrice: DataPoint<number> | null;
  readonly availability: DataPoint<AvailabilityState>;
  /** Campos que la fuente no pudo dar. Se enseñan al club en el preview. */
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
}

export interface EventRef {
  readonly url?: string;
  readonly externalId?: string;
}

export interface CheckoutOptions {
  /**
   * Etiqueta que se añade al enlace y que la ticketera recibe tal cual.
   * La escribimos y nunca la leemos de vuelta: sirve para que el club vea el
   * origen dentro de SU ticketera. No es atribución nuestra ni alimenta
   * ningún cálculo de comisiones — la plataforma no toca el dinero de las
   * entradas.
   */
  readonly referralTag?: string;
}

export interface TicketingProvider {
  readonly capabilities: ProviderCapabilities;
  getEvent(ref: EventRef): Promise<NormalizedEvent>;
  getEvents(ref: { profileUrl: string }): Promise<readonly NormalizedEvent[]>;
  getCheckoutUrl(ref: EventRef, options?: CheckoutOptions): string | null;
}

/*
 * Nota deliberada sobre lo que este contrato NO tiene:
 *
 * No hay getSales(), ni getPromoterAttribution(), ni nada que devuelva dinero
 * o volumen de ventas. Vendemos software: el club y el promoter nos pagan una
 * suscripción, el cliente paga su entrada a Fourvenues y Fourvenues gestiona
 * el cobro. Leer ventas solo tendría sentido para repartir dinero, y eso no
 * es nuestro negocio.
 *
 * Si algún día un club quiere ver sus propias ventas, será una integración
 * suya con su ticketera, no una función de esta interfaz.
 */
