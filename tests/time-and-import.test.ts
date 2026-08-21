import { describe, it, expect } from "vitest";
import { nightOf, nightWeekdayEs, refreshIntervalSeconds, formatEventWhen } from "@nightlife/core/time";
import { parseEventPage, parseJsonLdEvent, parseOpenGraph, guessDjsFromTitle } from "@nightlife/ticketing/parse";
import { normalizeEvent } from "@nightlife/ticketing/normalize";
import { ManualSource } from "@nightlife/ticketing/manual";

describe("la unidad del producto es la noche, no el día", () => {
  it("las 00:30 del sábado pertenecen a la noche del viernes", () => {
    // 2026-08-29 es sábado. Un evento a las 00:30 es la fiesta del viernes 28.
    const date = new Date("2026-08-29T00:30:00+02:00");
    expect(nightOf(date, "Europe/Madrid")).toBe("2026-08-28");
    expect(nightWeekdayEs(date, "Europe/Madrid")).toBe("viernes");
  });

  it("las 23:59 del sábado siguen siendo la noche del sábado", () => {
    const date = new Date("2026-08-29T23:59:00+02:00");
    expect(nightOf(date, "Europe/Madrid")).toBe("2026-08-29");
    expect(nightWeekdayEs(date, "Europe/Madrid")).toBe("sábado");
  });

  it("las 05:00 siguen siendo la noche anterior; las 07:00 ya no", () => {
    expect(nightOf(new Date("2026-08-29T05:00:00+02:00"), "Europe/Madrid")).toBe("2026-08-28");
    expect(nightOf(new Date("2026-08-29T07:00:00+02:00"), "Europe/Madrid")).toBe("2026-08-29");
  });

  it("formatea la fecha en la zona del club, no en UTC", () => {
    const date = new Date("2026-08-29T22:00:00Z"); // 00:00 del 30 en Madrid
    expect(formatEventWhen(date, "Europe/Madrid")).toMatch(/00:00/);
  });
});

describe("frecuencia de sincronización adaptativa", () => {
  const now = new Date("2026-08-21T14:00:00Z");

  it("cada 10 minutos en las 48 horas previas", () => {
    expect(refreshIntervalSeconds(new Date("2026-08-22T23:00:00Z"), now)).toBe(600);
  });

  it("cada hora dentro de la semana", () => {
    expect(refreshIntervalSeconds(new Date("2026-08-25T23:00:00Z"), now)).toBe(3600);
  });

  it("cada 6 horas a más de una semana vista", () => {
    expect(refreshIntervalSeconds(new Date("2026-09-15T23:00:00Z"), now)).toBe(21_600);
  });

  it("deja de sincronizar cuando el evento ya ha terminado", () => {
    expect(refreshIntervalSeconds(new Date("2026-08-20T23:00:00Z"), now)).toBe(0);
  });
});

describe("extracción desde la página pública", () => {
  const JSON_LD_PAGE = `<!doctype html><html><head>
    <meta property="og:image" content="https://cdn.example.com/cover.jpg">
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "MusicEvent",
      "name": "Summer Closing",
      "startDate": "2026-08-29T23:59:00+02:00",
      "location": { "@type": "Place", "name": "Club Neon" },
      "performer": [{ "@type": "Person", "name": "DJ X" }],
      "offers": [
        { "@type": "Offer", "name": "Early Bird", "price": 15, "priceCurrency": "EUR", "availability": "https://schema.org/SoldOut" },
        { "@type": "Offer", "name": "2nd Release", "price": 20, "priceCurrency": "EUR", "availability": "https://schema.org/InStock", "url": "https://fourvenues.com/club-neon/events/summer-closing" }
      ]
    }
    </script></head><body></body></html>`;

  it("lee el evento del JSON-LD con confianza alta", () => {
    const raw = parseJsonLdEvent(JSON_LD_PAGE);
    expect(raw?.name).toBe("Summer Closing");
    expect(raw?.confidence).toBe(0.9);
    expect(raw?.offers).toHaveLength(2);
    expect(raw?.performers).toEqual(["DJ X"]);
  });

  it("completa con Open Graph lo que falta sin pisar lo mejor", () => {
    const raw = parseEventPage(JSON_LD_PAGE);
    expect(raw?.image).toBe("https://cdn.example.com/cover.jpg");
    expect(raw?.extractedFrom).toBe("JSON_LD");
  });

  it("de extremo a extremo saca el precio vigente correcto", () => {
    const raw = parseEventPage(JSON_LD_PAGE)!;
    const event = normalizeEvent(raw, {
      sourceUrl: "https://fourvenues.com/club-neon/events/summer-closing",
      now: new Date("2026-08-21T14:32:00Z"),
    });
    expect(event.currentPrice?.value).toBe(2000);
    expect(event.name.value).toBe("Summer Closing");
    expect(event.ticketUrl?.value).toMatch(/summer-closing/);
  });

  it("cae a Open Graph cuando no hay JSON-LD, con confianza baja", () => {
    const ogOnly = `<html><head>
      <meta property="og:title" content="Winter Opening">
      <meta property="og:description" content="La vuelta">
    </head></html>`;
    const raw = parseOpenGraph(ogOnly);
    expect(raw?.name).toBe("Winter Opening");
    expect(raw?.confidence).toBe(0.6);
  });

  it("un JSON-LD roto no tumba el import", () => {
    const broken = `<html><head>
      <script type="application/ld+json">{ esto no es json }</script>
      <meta property="og:title" content="Evento B">
    </head></html>`;
    expect(parseEventPage(broken)?.name).toBe("Evento B");
  });

  it("devuelve null cuando la página no dice nada útil, en lugar de inventar", () => {
    expect(parseEventPage("<html><body>hola</body></html>")).toBeNull();
  });

  it("el cartel deducido del título queda por debajo del umbral para afirmarse", () => {
    expect(guessDjsFromTitle("SUMMER CLOSING w/ DJ X b2b DJ Y")).toEqual(["DJ X", "DJ Y"]);
    const event = normalizeEvent(
      { name: "SUMMER CLOSING w/ DJ X", offers: [], confidence: 0.9, extractedFrom: "JSON_LD" },
      { sourceUrl: "https://fourvenues.com/c/events/x", now: new Date() },
    );
    expect(event.dj?.confidence).toBeLessThan(0.6);
    expect(event.warnings.join(" ")).toMatch(/Revísalo/);
  });
});

describe("ManualSource: el plan B siempre funciona", () => {
  it("produce un evento completo con confianza 1", async () => {
    const source = new ManualSource({
      name: "Winter Opening",
      startsAtIso: "2026-10-03T23:59:00+02:00",
      ticketUrl: "https://fourvenues.com/club-neon/events/winter-opening",
      currentPriceCents: 1800,
      nextPriceCents: 2200,
    });
    const event = await source.getEvent({});
    expect(event.currentPrice?.value).toBe(1800);
    expect(event.currentPrice?.confidence).toBe(1);
    expect(event.currentPrice?.source).toBe("MANUAL");
    expect(event.availability.value).toBe("AVAILABLE");
  });

  it("declara que no sabe de disponibilidad real", () => {
    const source = new ManualSource({
      name: "x",
      startsAtIso: "2026-10-03T23:59:00+02:00",
      ticketUrl: "https://fourvenues.com/c/events/x",
    });
    expect(source.capabilities.supportsAvailability).toBe(false);
  });

  it("añade la etiqueta de origen al enlace de checkout", () => {
    const source = new ManualSource({
      name: "x",
      startsAtIso: "2026-10-03T23:59:00+02:00",
      ticketUrl: "https://fourvenues.com/c/events/x",
    });
    expect(source.getCheckoutUrl({}, { referralTag: "alex" })).toMatch(/promoter=alex/);
  });
});
