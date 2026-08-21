/**
 * FourvenuesPublicSource — lectura de información pública de un evento.
 *
 * Lo que este módulo hace y no hace está escrito en código, no solo en la
 * documentación:
 *
 *   · Solo URLs públicas de evento. Cualquier ruta que huela a panel privado
 *     se rechaza antes de hacer la petición.
 *   · Se consulta y respeta robots.txt.
 *   · User-Agent identificable, con URL de contacto.
 *   · Un intervalo mínimo entre peticiones, por host, siempre.
 *   · Backoff ante 429/503 y rendición ante 401/403: si la fuente dice que no,
 *     la respuesta correcta es degradar a entrada manual y avisar al club.
 *   · Sin login, sin CAPTCHA, sin cabeceras fingidas para parecer un navegador,
 *     sin reintentos agresivos y sin rotación de IP.
 *
 * Cuando exista acuerdo con Fourvenues, FourvenuesOfficialApi implementa la
 * misma interfaz y el resto de la aplicación no se entera del cambio.
 */

import { AppError } from "@nightlife/core/errors";
import { EXTRACTION_CONFIDENCE } from "@nightlife/core/provenance";
import { normalizeEvent } from "./normalize";
import { parseEventPage } from "./parse";
import type {
  CheckoutOptions,
  EventRef,
  NormalizedEvent,
  ProviderCapabilities,
  TicketingProvider,
} from "./types";

const ALLOWED_HOSTS = ["fourvenues.com", "www.fourvenues.com"];

/** Segmentos que indican zona privada. Si aparecen, ni se intenta. */
const FORBIDDEN_SEGMENTS = [
  "login", "signin", "signup", "register", "admin", "dashboard", "panel",
  "account", "checkout", "payment", "api", "backoffice", "manager",
];

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface FourvenuesOptions {
  readonly fetchImpl?: FetchLike;
  readonly userAgent?: string;
  readonly contactUrl?: string;
  readonly minRequestIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export const FOURVENUES_PUBLIC_CAPABILITIES: ProviderCapabilities = {
  id: "fourvenues-public",
  label: "Fourvenues (información pública)",
  supportsEventLookup: true,
  supportsTicketTypes: true,
  supportsCurrentPrice: true,
  // Una página pública dice si se puede comprar, no cuántas entradas quedan.
  // Por eso el bot nunca dirá "quedan 10".
  supportsAvailability: false,
  minRequestIntervalMs: 3000,
};

export class FourvenuesPublicSource implements TicketingProvider {
  readonly capabilities = FOURVENUES_PUBLIC_CAPABILITIES;

  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private lastRequestAt = 0;
  private robotsCache = new Map<string, { disallow: string[]; fetchedAt: number }>();

  constructor(options: FourvenuesOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const contact = options.contactUrl ?? "https://nightlifeautomatico.com/bot";
    this.userAgent = options.userAgent ?? `NightlifeAutomaticoBot/1.0 (+${contact})`;
    this.minIntervalMs = options.minRequestIntervalMs ?? this.capabilities.minRequestIntervalMs;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  async getEvent(ref: EventRef): Promise<NormalizedEvent> {
    if (!ref.url) throw AppError.validation("Hace falta la URL del evento");
    const url = assertPublicEventUrl(ref.url);

    if (!(await this.isAllowedByRobots(url))) {
      throw new AppError(
        "SOURCE_FORBIDDEN",
        "El robots.txt de la fuente no permite leer esta página. Puedes introducir los datos del evento a mano.",
      );
    }

    const html = await this.get(url);
    const raw = parseEventPage(html);
    if (!raw) {
      throw new AppError(
        "PARSE_FAILED",
        "No se ha podido leer la información del evento en esa página. Revisa la URL o introduce los datos a mano.",
      );
    }

    return normalizeEvent(raw, {
      sourceUrl: url,
      now: this.now(),
      baseConfidence:
        raw.extractedFrom === "JSON_LD"
          ? EXTRACTION_CONFIDENCE.JSON_LD
          : raw.extractedFrom === "HYDRATED_STATE"
            ? EXTRACTION_CONFIDENCE.HYDRATED_STATE
            : EXTRACTION_CONFIDENCE.OPEN_GRAPH,
    });
  }

  async getEvents(ref: { profileUrl: string }): Promise<readonly NormalizedEvent[]> {
    const url = assertPublicUrl(ref.profileUrl);
    if (!(await this.isAllowedByRobots(url))) {
      throw new AppError("SOURCE_FORBIDDEN", "El robots.txt de la fuente no permite leer esta página.");
    }
    const html = await this.get(url);
    const links = extractEventLinks(html, url);
    const events: NormalizedEvent[] = [];
    // En serie y con intervalo: importar el perfil de un club no debe
    // convertirse en una ráfaga de peticiones.
    for (const link of links.slice(0, 20)) {
      try {
        events.push(await this.getEvent({ url: link }));
      } catch {
        // Un evento ilegible no invalida los demás; aparece como faltante.
      }
    }
    return events;
  }

  getCheckoutUrl(ref: EventRef, options?: CheckoutOptions): string | null {
    if (!ref.url) return null;
    try {
      const url = new URL(ref.url);
      if (options?.referralTag) {
        // Se escribe y no se lee nunca de vuelta. Es información para la
        // ticketera del club, no un dato nuestro: no hay nada en la
        // plataforma que consulte ventas por esta etiqueta.
        // Si Fourvenues usa otro nombre de parámetro, se cambia aquí y en
        // ningún otro sitio.
        url.searchParams.set("promoter", options.referralTag);
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private async get(url: string): Promise<string> {
    await this.throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new AppError(
          "SOURCE_FORBIDDEN",
          "La fuente ha rechazado la petición. No intentamos rodearlo: introduce los datos a mano o usa la API oficial cuando esté disponible.",
        );
      }
      if (response.status === 429 || response.status >= 500) {
        throw new AppError(
          "SOURCE_UNAVAILABLE",
          "La fuente no responde ahora mismo. Se reintentará más tarde.",
        );
      }
      if (!response.ok) {
        throw new AppError("SOURCE_UNAVAILABLE", `La fuente devolvió ${response.status}`);
      }
      return await response.text();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("SOURCE_UNAVAILABLE", "No se ha podido contactar con la fuente");
    } finally {
      clearTimeout(timer);
    }
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private async isAllowedByRobots(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    const cached = this.robotsCache.get(origin);
    const fresh = cached && Date.now() - cached.fetchedAt < 3_600_000;

    let disallow: string[];
    if (fresh && cached) {
      disallow = cached.disallow;
    } else {
      try {
        const response = await this.fetchImpl(`${origin}/robots.txt`, {
          headers: { "User-Agent": this.userAgent },
        });
        // Sin robots.txt legible se asume permitido, que es el comportamiento
        // que define el estándar.
        disallow = response.ok ? parseRobotsDisallow(await response.text()) : [];
      } catch {
        disallow = [];
      }
      this.robotsCache.set(origin, { disallow, fetchedAt: Date.now() });
    }

    const path = new URL(url).pathname;
    return !disallow.some((rule) => rule.length > 0 && path.startsWith(rule));
  }
}

// ── helpers exportados para poder testearlos ────────────────────────

export function assertPublicUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw AppError.validation("La URL no es válida");
  }
  if (url.protocol !== "https:") {
    throw AppError.validation("La URL debe empezar por https://");
  }
  if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    throw AppError.validation(`Solo se admiten URLs de ${ALLOWED_HOSTS[0]}`);
  }
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.some((s) => FORBIDDEN_SEGMENTS.includes(s))) {
    throw AppError.validation(
      "Esa URL apunta a una zona privada o de pago. Usa la página pública del evento.",
    );
  }
  url.hash = "";
  return url.toString();
}

export function assertPublicEventUrl(input: string): string {
  const url = assertPublicUrl(input);
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw AppError.validation(
      "Esa URL no parece la de un evento concreto. Copia el enlace del evento en Fourvenues.",
    );
  }
  return url;
}

export function parseRobotsDisallow(robotsTxt: string, userAgent = "*"): string[] {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const disallow: string[] = [];
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase() === userAgent.toLowerCase();
    } else if (key === "disallow" && applies && value.length > 0) {
      disallow.push(value);
    }
  }
  return disallow;
}

export function extractEventLinks(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (!ALLOWED_HOSTS.includes(resolved.hostname.toLowerCase())) continue;
      if (!/\/(events?|e|entradas)\//i.test(resolved.pathname)) continue;
      resolved.hash = "";
      found.add(resolved.toString());
    } catch {
      // href relativo raro: se ignora
    }
  }
  return [...found];
}
