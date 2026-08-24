/**
 * Fourvenues Integrations API — cliente oficial.
 *
 * Sustituye al lector de páginas públicas como fuente de verdad. Contrato real,
 * documentado en https://docs.fourvenues.com/integrations:
 *
 *   Base   https://api-alpha.fourvenues.com/integrations   (alpha, datos de prueba)
 *          https://api.fourvenues.com/integrations         (producción)
 *   Auth   cabecera  X-Api-Key: <key del club>
 *   GET    /channels/                       → equipos/canales de la organización
 *   GET    /events/?start=&end=             → eventos
 *   GET    /tickets-rates/?event_id=        → tarifas y sus opciones de precio
 *
 * Límites que la documentación pide respetar y que aquí son código, no un
 * comentario: no más de una consulta por minuto al mismo recurso, no más de
 * diez peticiones por segundo con la misma key, y backoff exponencial ante un
 * 429.
 *
 * LA KEY NO SALE DE AQUÍ. Entra por el constructor, viaja en una cabecera y no
 * aparece en ningún mensaje de error, ni en el texto de una excepción, ni en
 * una URL. Los errores se traducen a un código nuestro (`FourvenuesApiError`)
 * antes de subir, precisamente para que nadie más arriba tenga la tentación de
 * imprimir el cuerpo de la respuesta.
 *
 * Lo que esta API **no** da, y por tanto el bot nunca dirá:
 *   · stock restante — `max_quantity` es el máximo por compra, no lo que queda;
 *   · qué release está agotado. Con varias opciones de precio sabemos la
 *     escalera pero no en qué escalón está hoy, así que el precio se marca con
 *     confianza por debajo del umbral para afirmar y el bot manda al checkout
 *     en lugar de cantar una cifra que puede estar agotada.
 */

import { EXTRACTION_CONFIDENCE, DEFAULT_TTL_SECONDS, dataPoint } from "@nightlife/core/provenance";
import type { DataPoint } from "@nightlife/core/provenance";
import { redact } from "@nightlife/core/secret-box";
import type {
  AvailabilityState,
  EventRef,
  NormalizedEvent,
  NormalizedTicketType,
  ProviderCapabilities,
} from "./types";

export const FOURVENUES_ENVIRONMENTS = {
  ALPHA: "https://api-alpha.fourvenues.com/integrations",
  PRODUCTION: "https://api.fourvenues.com/integrations",
} as const;

export type FourvenuesEnvironment = keyof typeof FOURVENUES_ENVIRONMENTS;

export const FOURVENUES_API_CAPABILITIES: ProviderCapabilities = {
  id: "fourvenues-api",
  label: "Fourvenues (API oficial)",
  supportsEventLookup: true,
  supportsTicketTypes: true,
  supportsCurrentPrice: true,
  // La API no publica stock. Esta línea es la que impide que el validador deje
  // pasar un «quedan pocas».
  supportsAvailability: false,
  minRequestIntervalMs: 1_000,
};

/** Códigos que sí pueden subir. Ninguno lleva datos de la respuesta original. */
export type FourvenuesErrorCode =
  | "INVALID_KEY"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "UPSTREAM"
  | "NETWORK"
  | "MALFORMED";

export class FourvenuesApiError extends Error {
  constructor(
    readonly code: FourvenuesErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FourvenuesApiError";
  }

  /**
   * Lo único que puede leer un cliente del navegador. Sin códigos HTTP, sin
   * texto de la ticketera y, obviamente, sin la key.
   */
  get publicMessage(): string {
    switch (this.code) {
      case "INVALID_KEY":
      case "FORBIDDEN":
        return "We couldn't connect to Fourvenues. Check your key and try again.";
      case "RATE_LIMITED":
        return "Fourvenues is asking us to slow down. Try again in a minute.";
      case "NOT_FOUND":
        return "We couldn't find that in your Fourvenues account.";
      default:
        return "We couldn't reach Fourvenues right now. Try again in a moment.";
    }
  }
}

export interface FourvenuesChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** Tal y como llega de /events/. Nada de esto se usa sin pasar por normalize. */
interface RawApiEvent {
  _id?: string;
  name?: string;
  slug?: string;
  url?: string;
  flyer?: string;
  description?: string;
  date?: number;
  start?: number;
  end?: number;
  age?: number;
  music_genres?: string;
  outfit?: string;
  location_town?: string;
  artists?: string[];
  active?: boolean;
  visible?: boolean;
}

interface RawRateOption {
  _id?: string;
  price?: number;
  max_quantity?: number;
  age?: number;
  until?: number;
  content?: string;
  additional_info?: string;
}

interface RawRate {
  _id?: string;
  name?: string;
  slug?: string;
  options?: RawRateOption[];
}

export interface ApiFetchLike {
  (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface FourvenuesApiOptions {
  readonly apiKey: string;
  readonly environment?: FourvenuesEnvironment;
  readonly fetchImpl?: ApiFetchLike;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Espera mínima entre peticiones. La documentación pide 10 req/s como techo. */
  readonly minRequestIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Los timestamps de la API vienen en segundos epoch. Un valor en milisegundos
 * colado por error daría un evento en el año 56.000, así que se comprueba el
 * rango en lugar de confiar.
 */
export function epochSecondsToDate(value: number | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const seconds = value > 1e12 ? value / 1000 : value;
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return date;
}

/**
 * Los precios llegan como número decimal en euros (`"price": 10`). Se pasan a
 * céntimos, que es la única unidad que circula por dentro. Un precio con más
 * de dos decimales o absurdamente grande se descarta en vez de redondearse:
 * un dato raro que se guarda con buena cara es un dato que el bot afirmará.
 */
export function priceToCents(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 100_000) return null;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : null;
}

export class FourvenuesApi {
  private readonly apiKey: string;
  private readonly base: string;
  private readonly fetchImpl: ApiFetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly minInterval: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  readonly capabilities = FOURVENUES_API_CAPABILITIES;
  readonly environment: FourvenuesEnvironment;

  constructor(options: FourvenuesApiOptions) {
    if (!options.apiKey || options.apiKey.trim().length < 8) {
      throw new FourvenuesApiError("INVALID_KEY", "Missing API key");
    }
    this.apiKey = options.apiKey.trim();
    this.environment = options.environment ?? "PRODUCTION";
    this.base = FOURVENUES_ENVIRONMENTS[this.environment];
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ApiFetchLike);
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.minInterval = options.minRequestIntervalMs ?? FOURVENUES_API_CAPABILITIES.minRequestIntervalMs;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── transporte ──────────────────────────────────────────────────────

  private async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }

    // Ritmo. No es cortesía: es la condición para que no nos corten la key.
    const since = this.now().getTime() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && since < this.minInterval) {
      await this.sleep(this.minInterval - since);
    }

    let lastError: FourvenuesApiError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await this.sleep(500 * 2 ** attempt);
      this.lastRequestAt = this.now().getTime();

      let response: { ok: boolean; status: number; text(): Promise<string> };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          response = await this.fetchImpl(url.toString(), {
            headers: {
              // La key vive exactamente aquí y en ningún otro sitio.
              "X-Api-Key": this.apiKey,
              accept: "application/json",
              "user-agent": "NightlifeAutomatico/1.0 (+https://nightlifeautomatico.com)",
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // El mensaje de red puede traer la URL; la URL no lleva la key, pero
        // se pasa por redact igualmente porque esto es la última red.
        lastError = new FourvenuesApiError(
          "NETWORK",
          redact(error instanceof Error ? error.message : "network error", this.apiKey),
        );
        continue;
      }

      if (response.status === 401) throw new FourvenuesApiError("INVALID_KEY", "Rejected key", 401);
      if (response.status === 403) throw new FourvenuesApiError("FORBIDDEN", "Key lacks access", 403);
      if (response.status === 404) throw new FourvenuesApiError("NOT_FOUND", "Not found", 404);
      if (response.status === 429) {
        lastError = new FourvenuesApiError("RATE_LIMITED", "Throttled", 429);
        continue;
      }
      if (!response.ok) {
        lastError = new FourvenuesApiError("UPSTREAM", "Upstream error", response.status);
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch {
        throw new FourvenuesApiError("MALFORMED", "Unreadable response");
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("data" in (payload as Record<string, unknown>))
      ) {
        throw new FourvenuesApiError("MALFORMED", "Response without data");
      }
      return (payload as { data: T }).data;
    }

    throw lastError ?? new FourvenuesApiError("UPSTREAM", "Gave up after retries");
  }

  // ── recursos ────────────────────────────────────────────────────────

  /**
   * Verificar la key. Es la llamada más barata que confirma tres cosas a la
   * vez: la key existe, tiene permisos y la organización es alcanzable.
   */
  async listChannels(): Promise<FourvenuesChannel[]> {
    const data = await this.get<unknown>("/channels/");
    if (!Array.isArray(data)) throw new FourvenuesApiError("MALFORMED", "channels is not a list");
    return data
      .map((raw) => raw as { _id?: string; name?: string; slug?: string })
      .filter((raw) => typeof raw._id === "string" && raw._id.length > 0)
      .map((raw) => ({
        id: raw._id as string,
        name: raw.name ?? "Untitled",
        slug: raw.slug ?? "",
      }));
  }

  /** Eventos en una ventana de fechas. Sin ventana, los próximos 120 días. */
  async listEvents(window?: { start?: Date; end?: Date }): Promise<NormalizedEvent[]> {
    const start = window?.start ?? this.now();
    const end = window?.end ?? new Date(this.now().getTime() + 120 * 86_400_000);
    const data = await this.get<unknown>("/events/", {
      start: isoDay(start),
      end: isoDay(end),
    });
    if (!Array.isArray(data)) throw new FourvenuesApiError("MALFORMED", "events is not a list");
    return (data as RawApiEvent[])
      .filter((raw) => typeof raw._id === "string" && raw._id.length > 0)
      .map((raw) => this.normalizeApiEvent(raw, []));
  }

  /** Tarifas de un evento. Cada tarifa trae su escalera de opciones de precio. */
  async listTicketRates(eventId: string): Promise<RawRate[]> {
    const data = await this.get<unknown>("/tickets-rates/", { event_id: eventId });
    if (!Array.isArray(data)) throw new FourvenuesApiError("MALFORMED", "rates is not a list");
    return data as RawRate[];
  }

  /** Un evento con sus precios ya resueltos. Dos llamadas, una por recurso. */
  async getEventWithRates(eventId: string): Promise<NormalizedEvent | null> {
    const events = await this.listEvents({
      start: new Date(this.now().getTime() - 30 * 86_400_000),
      end: new Date(this.now().getTime() + 365 * 86_400_000),
    });
    const found = events.find((e) => e.externalId === eventId);
    if (!found) return null;
    const rates = await this.listTicketRates(eventId);
    return this.withRates(found, rates);
  }

  getCheckoutUrl(ref: EventRef): string | null {
    // La URL la publica Fourvenues en el propio evento. No se compone.
    return ref.url && ref.url.startsWith("https://") ? ref.url : null;
  }

  // ── normalización ───────────────────────────────────────────────────

  private dp<T>(value: T, field: string, ttl: number, confidence: number): DataPoint<T> {
    return dataPoint({
      value,
      source: "FOURVENUES",
      confidence,
      field,
      ttlSeconds: ttl,
      lastUpdated: this.now(),
    });
  }

  normalizeApiEvent(raw: RawApiEvent, rates: RawRate[]): NormalizedEvent {
    const conf = EXTRACTION_CONFIDENCE.OFFICIAL_API;
    const missing: string[] = [];
    const warnings: string[] = [];

    const startsAt = epochSecondsToDate(raw.start) ?? epochSecondsToDate(raw.date);
    if (!startsAt) missing.push("startsAt");
    if (!raw.flyer) missing.push("imageUrl");
    if (!raw.description) missing.push("description");

    const url = typeof raw.url === "string" && raw.url.startsWith("https://") ? raw.url : null;
    if (!url) {
      missing.push("ticketUrl");
      warnings.push("Fourvenues didn't return a public link for this event, so there's nothing to buy from yet.");
    }

    const base: NormalizedEvent = {
      externalId: raw._id as string,
      sourceUrl: url ?? "",
      name: this.dp(raw.name ?? "Untitled event", "eventName", DEFAULT_TTL_SECONDS.eventName, conf),
      startsAt: startsAt
        ? this.dp(startsAt.toISOString(), "startsAt", DEFAULT_TTL_SECONDS.startsAt, conf)
        : null,
      venueName: raw.location_town
        ? this.dp(raw.location_town, "venueName", DEFAULT_TTL_SECONDS.clubInfo, conf)
        : null,
      description: raw.description
        ? this.dp(raw.description, "description", DEFAULT_TTL_SECONDS.description, conf)
        : null,
      imageUrl: raw.flyer ? this.dp(raw.flyer, "imageUrl", DEFAULT_TTL_SECONDS.imageUrl, conf) : null,
      // Los artistas vienen en su propio campo: no hay que adivinarlos del
      // título, que es de donde salían los falsos positivos del lector público.
      dj:
        Array.isArray(raw.artists) && raw.artists.length > 0
          ? this.dp(raw.artists.filter((a) => typeof a === "string"), "dj", DEFAULT_TTL_SECONDS.dj, conf)
          : null,
      ticketUrl: url ? this.dp(url, "ticketUrl", DEFAULT_TTL_SECONDS.ticketUrl, conf) : null,
      ticketTypes: [],
      currentPrice: null,
      nextPrice: null,
      availability: this.dp<AvailabilityState>(
        "UNKNOWN",
        "availability",
        DEFAULT_TTL_SECONDS.availability,
        conf,
      ),
      missingFields: missing,
      warnings,
    };

    return rates.length > 0 ? this.withRates(base, rates) : base;
  }

  /**
   * Pega la escalera de precios a un evento ya normalizado.
   *
   * Regla del producto: el precio de hoy es el más barato **disponible**. La
   * API no dice cuál está agotado, así que con más de una opción el precio se
   * guarda por debajo del umbral para afirmar: aparece en el panel, la IA lo
   * usa como contexto, pero no lo canta. Con una sola opción no hay ambigüedad
   * posible y sí se puede afirmar.
   */
  withRates(event: NormalizedEvent, rates: RawRate[]): NormalizedEvent {
    const conf = EXTRACTION_CONFIDENCE.OFFICIAL_API;
    const types: NormalizedTicketType[] = [];

    for (const rate of rates) {
      const options = Array.isArray(rate.options) ? rate.options : [];
      options.forEach((option, index) => {
        const cents = priceToCents(option.price);
        const label =
          options.length === 1
            ? (rate.name ?? "Ticket")
            : `${rate.name ?? "Ticket"} · ${option.content ?? `Option ${index + 1}`}`;
        types.push({
          ...(option._id ? { externalId: option._id } : {}),
          name: label,
          sortOrder: types.length,
          priceCents:
            cents === null
              ? null
              : this.dp(cents, "ticketTypePrice", DEFAULT_TTL_SECONDS.ticketTypes, conf),
          // Sin dato de stock, UNKNOWN. Nunca AVAILABLE por defecto.
          status: this.dp<AvailabilityState>(
            "UNKNOWN",
            "ticketTypeStatus",
            DEFAULT_TTL_SECONDS.availability,
            conf,
          ),
        });
      });
    }

    const priced = types
      .map((t) => t.priceCents?.value)
      .filter((c): c is number => typeof c === "number")
      .sort((a, b) => a - b);

    const warnings = [...event.warnings];
    let currentPrice: DataPoint<number> | null = null;
    let nextPrice: DataPoint<number> | null = null;

    if (priced.length === 1) {
      currentPrice = this.dp(priced[0] as number, "currentPrice", DEFAULT_TTL_SECONDS.currentPrice, conf);
    } else if (priced.length > 1) {
      currentPrice = this.dp(
        priced[0] as number,
        "currentPrice",
        DEFAULT_TTL_SECONDS.currentPrice,
        // Deliberadamente por debajo de MIN_CONFIDENCE_TO_ASSERT.
        EXTRACTION_CONFIDENCE.OPEN_GRAPH,
      );
      nextPrice = this.dp(
        priced[1] as number,
        "nextPrice",
        DEFAULT_TTL_SECONDS.nextPrice,
        EXTRACTION_CONFIDENCE.OPEN_GRAPH,
      );
      warnings.push(
        "This event has several ticket prices and Fourvenues doesn't tell us which release is still on sale, so the assistant sends people to the ticket page instead of quoting one price.",
      );
    }

    return { ...event, ticketTypes: types, currentPrice, nextPrice, warnings };
  }
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
