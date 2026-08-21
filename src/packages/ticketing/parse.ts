/**
 * Extracción de datos públicos de una página de evento.
 *
 * Sin cheerio ni jsdom a propósito: solo nos interesan tres cosas que están
 * en formatos declarados y estables — JSON-LD schema.org, el estado hidratado
 * del framework y las metaetiquetas Open Graph. Rascar el HTML visible con
 * selectores es justo lo que se rompe cuando la fuente cambia la maquetación,
 * y lo que acaba metiendo un precio equivocado en boca del bot.
 *
 * Cada extractor devuelve además su confianza. El orden es deliberado:
 * JSON-LD (0.9) > estado hidratado (0.8) > Open Graph (0.6).
 */

import { EXTRACTION_CONFIDENCE } from "@nightlife/core/provenance";

export interface RawOffer {
  price?: number | string;
  priceCurrency?: string;
  name?: string;
  availability?: string;
  url?: string;
  validFrom?: string;
}

export interface RawEventData {
  name?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  image?: string;
  url?: string;
  locationName?: string;
  performers?: string[];
  offers: RawOffer[];
  eventStatus?: string;
  confidence: number;
  extractedFrom: "JSON_LD" | "HYDRATED_STATE" | "OPEN_GRAPH";
}

/** Todos los bloques <script type="application/ld+json"> de la página. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern =
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body.trim()));
    } catch {
      // Un JSON-LD roto no es motivo para abortar el import: seguimos con
      // los demás extractores y el club lo confirma a mano en el preview.
    }
  }
  return blocks;
}

/** Aplana @graph y arrays para encontrar el nodo Event esté donde esté. */
function flattenJsonLd(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    out.push(obj);
    if ("@graph" in obj) flattenJsonLd(obj["@graph"], out);
  }
  return out;
}

const EVENT_TYPES = new Set([
  "Event", "MusicEvent", "SocialEvent", "Festival", "DanceEvent", "TheaterEvent",
]);

function isEventNode(obj: Record<string, unknown>): boolean {
  const type = obj["@type"];
  if (typeof type === "string") return EVENT_TYPES.has(type);
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && EVENT_TYPES.has(t));
  return false;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

function normalizeOffers(raw: unknown): RawOffer[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const offers: RawOffer[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const price = typeof o["price"] === "number" ? o["price"] : asString(o["price"]);
    const offer: RawOffer = {};
    if (price !== undefined) offer.price = price;
    const currency = asString(o["priceCurrency"]);
    if (currency) offer.priceCurrency = currency;
    const name = asString(o["name"]) ?? asString(o["description"]);
    if (name) offer.name = name;
    const availability = asString(o["availability"]);
    if (availability) offer.availability = availability;
    const url = asString(o["url"]);
    if (url) offer.url = url;
    const validFrom = asString(o["validFrom"]);
    if (validFrom) offer.validFrom = validFrom;
    if (Object.keys(offer).length > 0) offers.push(offer);
  }
  return offers;
}

function performerNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === "string") { names.push(item); continue; }
    if (item && typeof item === "object") {
      const name = asString((item as Record<string, unknown>)["name"]);
      if (name) names.push(name);
    }
  }
  return names;
}

function locationName(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return asString((raw as Record<string, unknown>)["name"]);
  return undefined;
}

function imageUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((i) => typeof i === "string");
    if (typeof first === "string") return first;
  }
  if (raw && typeof raw === "object") return asString((raw as Record<string, unknown>)["url"]);
  return undefined;
}

export function parseJsonLdEvent(html: string): RawEventData | null {
  for (const block of extractJsonLdBlocks(html)) {
    for (const node of flattenJsonLd(block)) {
      if (!isEventNode(node)) continue;
      const name = asString(node["name"]);
      if (!name) continue;

      const data: RawEventData = {
        name,
        offers: normalizeOffers(node["offers"]),
        confidence: EXTRACTION_CONFIDENCE.JSON_LD,
        extractedFrom: "JSON_LD",
      };
      const startDate = asString(node["startDate"]);
      if (startDate) data.startDate = startDate;
      const endDate = asString(node["endDate"]);
      if (endDate) data.endDate = endDate;
      const description = asString(node["description"]);
      if (description) data.description = description;
      const image = imageUrl(node["image"]);
      if (image) data.image = image;
      const url = asString(node["url"]);
      if (url) data.url = url;
      const loc = locationName(node["location"]);
      if (loc) data.locationName = loc;
      const performers = performerNames(node["performer"]);
      if (performers.length > 0) data.performers = performers;
      const status = asString(node["eventStatus"]);
      if (status) data.eventStatus = status;
      return data;
    }
  }
  return null;
}

/** Metaetiquetas Open Graph: siempre están, pero dicen poco y valen 0.6. */
export function parseOpenGraph(html: string): RawEventData | null {
  const get = (property: string): string | undefined => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      "i",
    );
    const alt = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["']`,
      "i",
    );
    const m = html.match(pattern) ?? html.match(alt);
    const value = m?.[1]?.trim();
    return value && value.length > 0 ? value : undefined;
  };

  const name = get("og:title") ?? get("twitter:title");
  const image = get("og:image");
  // Una página con imagen pero sin título sigue aportando: se usa para
  // completar lo que el JSON-LD no traiga. Exigir el título descartaría
  // datos válidos.
  if (!name && !image) return null;

  const data: RawEventData = {
    offers: [],
    confidence: EXTRACTION_CONFIDENCE.OPEN_GRAPH,
    extractedFrom: "OPEN_GRAPH",
  };
  if (name) data.name = name;
  const description = get("og:description");
  if (description) data.description = description;
  if (image) data.image = image;
  const url = get("og:url");
  if (url) data.url = url;
  const start = get("event:start_time") ?? get("music:release_date");
  if (start) data.startDate = start;
  return data;
}

/**
 * Estado hidratado que la propia página publica para su framework
 * (__NEXT_DATA__, __NUXT__, window.__INITIAL_STATE__). Es información pública
 * que el navegador ya recibe; solo la leemos, no forzamos nada.
 */
export function parseHydratedState(html: string): Record<string, unknown> | null {
  const patterns = [
    /<script[^>]+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (!m?.[1]) continue;
    try {
      const parsed: unknown = JSON.parse(m[1].trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Estado no serializable como JSON puro: se ignora.
    }
  }
  return null;
}

/**
 * Punto de entrada. Prueba en orden de fiabilidad y fusiona: si JSON-LD trae
 * el evento pero no la imagen, Open Graph la completa sin pisar lo mejor.
 */
export function parseEventPage(html: string): RawEventData | null {
  const jsonLd = parseJsonLdEvent(html);
  const og = parseOpenGraph(html);

  if (jsonLd) {
    if (og) {
      if (!jsonLd.image && og.image) jsonLd.image = og.image;
      if (!jsonLd.description && og.description) jsonLd.description = og.description;
    }
    return jsonLd;
  }
  return og;
}

/** Nombres de DJ a partir de un título tipo "SUMMER CLOSING w/ DJ X b2b DJ Y". */
export function guessDjsFromTitle(title: string): string[] {
  const separators = /\s+(?:w\/|with|feat\.?|featuring|pres\.?|presents|invita a)\s+/i;
  const parts = title.split(separators);
  if (parts.length < 2) return [];
  const tail = parts.slice(1).join(" ");
  // Ojo con la "y": en "DJ X b2b DJ Y" la Y mayúscula es el nombre del
  // artista, no la conjunción. Solo se separa por " y " en minúscula.
  return tail
    .split(/\s*[,&+]\s*|\s+(?:b2b|B2B|B2b)\s+|\s+y\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 40);
}
