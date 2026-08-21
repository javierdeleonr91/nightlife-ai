import { describe, it, expect } from "vitest";
import { normalizeEvent } from "@nightlife/ticketing/normalize";
import type { RawEventData, RawOffer } from "@nightlife/ticketing/parse";
import { parseMoneyToCents, formatMoney, money, extractMonetaryAmounts } from "@nightlife/core/money";

const NOW = new Date("2026-08-21T14:32:00Z");

function raw(offers: RawOffer[], extra: Partial<RawEventData> = {}): RawEventData {
  return {
    name: "Summer Closing",
    startDate: "2026-08-29T23:59:00+02:00",
    offers,
    confidence: 0.9,
    extractedFrom: "JSON_LD",
    ...extra,
  };
}

const opts = { sourceUrl: "https://fourvenues.com/club/events/summer-closing", now: NOW };

describe("precio vigente en una escalera de releases", () => {
  // El caso central de la sección 12: Early Bird y 1st Release agotados,
  // 2nd Release disponible. El precio de ahora mismo son 20 €, no 15 €.
  const ladder: RawOffer[] = [
    { name: "Early Bird", price: 15, availability: "https://schema.org/SoldOut" },
    { name: "1st Release", price: 18, availability: "SoldOut" },
    { name: "2nd Release", price: 20, availability: "InStock" },
    { name: "3rd Release", price: 25, availability: "PreOrder" },
  ];

  it("elige el release disponible más barato, no el primero de la lista", () => {
    const event = normalizeEvent(raw(ladder), opts);
    expect(event.currentPrice?.value).toBe(2000);
  });

  it("sabe cuál es el siguiente escalón", () => {
    const event = normalizeEvent(raw(ladder), opts);
    expect(event.nextPrice?.value).toBe(2500);
  });

  it("no propone como vigente un release agotado", () => {
    const event = normalizeEvent(raw(ladder), opts);
    expect(event.currentPrice?.value).not.toBe(1500);
    expect(event.currentPrice?.value).not.toBe(1800);
  });

  it("marca disponibilidad AVAILABLE cuando hay al menos un release a la venta", () => {
    const event = normalizeEvent(raw(ladder), opts);
    expect(event.availability.value).toBe("AVAILABLE");
  });
});

describe("evento agotado", () => {
  const soldOut: RawOffer[] = [
    { name: "Early Bird", price: 15, availability: "SoldOut" },
    { name: "General", price: 20, availability: "SoldOut" },
  ];

  it("no expone precio vigente", () => {
    const event = normalizeEvent(raw(soldOut), opts);
    expect(event.currentPrice).toBeNull();
  });

  it("marca SOLD_OUT y lo avisa al club", () => {
    const event = normalizeEvent(raw(soldOut), opts);
    expect(event.availability.value).toBe("SOLD_OUT");
    expect(event.warnings.length).toBeGreaterThan(0);
  });
});

describe("la fuente no dice qué release está activo", () => {
  const noStatus: RawOffer[] = [{ name: "Entrada", price: 20 }, { name: "Entrada VIP", price: 40 }];

  it("guarda el precio pero con confianza por debajo del umbral para afirmarlo", () => {
    const event = normalizeEvent(raw(noStatus), opts);
    expect(event.currentPrice?.value).toBe(2000);
    // Por debajo de MIN_CONFIDENCE_TO_ASSERT: entra en el preview para que
    // una persona lo confirme, pero el bot no lo dirá.
    expect(event.currentPrice!.confidence).toBeLessThan(0.8);
  });

  it("avisa de que hace falta confirmación humana", () => {
    const event = normalizeEvent(raw(noStatus), opts);
    expect(event.warnings.join(" ")).toMatch(/confirmes/);
  });
});

describe("evento sin ningún precio", () => {
  it("declara currentPrice como campo faltante en lugar de inventarlo", () => {
    const event = normalizeEvent(raw([]), opts);
    expect(event.currentPrice).toBeNull();
    expect(event.missingFields).toContain("currentPrice");
  });

  it("deja la disponibilidad en UNKNOWN con confianza cero", () => {
    const event = normalizeEvent(raw([]), opts);
    expect(event.availability.value).toBe("UNKNOWN");
    expect(event.availability.confidence).toBe(0);
  });
});

describe("dinero", () => {
  it("lee precios escritos por humanos", () => {
    expect(parseMoneyToCents("20")).toBe(2000);
    expect(parseMoneyToCents("20€")).toBe(2000);
    expect(parseMoneyToCents("20,50 €")).toBe(2050);
    expect(parseMoneyToCents("€18.5")).toBe(1850);
    expect(parseMoneyToCents("Gratis")).toBe(0);
  });

  it("devuelve null cuando no hay lectura inequívoca", () => {
    expect(parseMoneyToCents("consultar")).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
  });

  it("formatea sin decimales cuando el precio es redondo", () => {
    expect(formatMoney(money(2000)).replace(/ /g, " ")).toBe("20 €");
    expect(formatMoney(money(2050)).replace(/ /g, " ")).toBe("20,50 €");
  });

  it("rechaza importes no enteros: nunca floats para dinero", () => {
    expect(() => money(19.99)).toThrow();
  });

  it("encuentra los importes de un texto para poder validarlos", () => {
    expect(extractMonetaryAmounts("Ahora mismo está a 20 € y luego sube a 25€")).toEqual([2000, 2500]);
    expect(extractMonetaryAmounts("Somos 8 personas")).toEqual([]);
  });
});
