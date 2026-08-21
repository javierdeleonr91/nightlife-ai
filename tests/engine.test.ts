import { describe, it, expect } from "vitest";
import { runEngine } from "@nightlife/ai/engine";
import type { ConversationContext } from "@nightlife/ai/context";
import { ScriptedProvider } from "@nightlife/ai/llm";
import { routeIntent, refineWithContext, extractPartySize } from "@nightlife/ai/intents";
import { dataPoint } from "@nightlife/core/provenance";

const NOW = new Date("2026-08-21T14:32:00Z");
const CHECKOUT = "https://fourvenues.com/club/events/summer-closing";

const dp = <T>(value: T, field: string, ttl: number, ageSeconds = 0, confidence = 0.9) =>
  dataPoint({
    value,
    source: "FOURVENUES" as const,
    confidence,
    field,
    ttlSeconds: ttl,
    lastUpdated: new Date(NOW.getTime() - ageSeconds * 1000),
  });

function context(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    club: {
      id: "club_1",
      name: "Club Neon",
      city: "Madrid",
      timezone: "Europe/Madrid",
      address: "Calle Falsa 123",
      minAge: 18,
      dressCode: "Nada de chándal ni deportivas de running.",
      openingHours: "Viernes y sábados de 00:00 a 06:00.",
      whatsapp: "+34600000000",
      instagram: "clubneon",
      policies: null,
    },
    event: {
      id: "evt_1",
      name: dp("Summer Closing", "eventName", 86_400),
      startsAt: dp("2026-08-29T23:59:00+02:00", "startsAt", 86_400),
      djs: null,
      currentPrice: dp(2000, "currentPrice", 600),
      nextPrice: dp(2500, "nextPrice", 600),
      availability: dp("AVAILABLE" as const, "availability", 300),
      ticketUrl: dp(CHECKOUT, "ticketUrl", 604_800),
      historicalPricesCents: [1500, 1800],
      status: "ACTIVE",
    },
    upcomingEvents: [],
    vipOptions: [],
    faqs: [],
    history: [],
    promoter: null,
    partySize: null,
    lastIntent: null,
    locale: "es",
    now: NOW,
    ...overrides,
  };
}

describe("clasificación de intents sin coste", () => {
  const cases: [string, string][] = [
    ["cuánto cuesta?", "TICKET_PRICE"],
    ["Cuanto vale bro", "TICKET_PRICE"],
    ["y cuánto costaba antes?", "PRICE_HISTORY"],
    ["cuánto costará la semana que viene", "PRICE_FUTURE"],
    ["quedan entradas?", "TICKET_AVAILABILITY"],
    ["quiero comprar 2", "BUY_TICKET"],
    ["quién pincha el sábado?", "DJ_INFO"],
    ["dónde estáis?", "LOCATION"],
    ["a qué hora abre", "OPENING_TIME"],
    ["qué edad mínima hay", "AGE_REQUIREMENT"],
    ["hay dress code?", "DRESS_CODE"],
    ["hay vip?", "VIP"],
    ["puedo celebrar mi cumpleaños", "BIRTHDAY"],
    ["me pones en lista?", "GUEST_LIST"],
    ["quiero hablar con alguien", "HUMAN_AGENT"],
    ["eres un bot?", "IS_BOT"],
    ["hola buenas", "GREETING"],
  ];

  for (const [message, expected] of cases) {
    it(`"${message}" → ${expected}`, () => {
      expect(routeIntent(message).intent).toBe(expected);
    });
  }

  it("distingue 'cuánto costaba' de 'cuánto cuesta'", () => {
    expect(routeIntent("cuánto costaba").intent).toBe("PRICE_HISTORY");
    expect(routeIntent("cuánto cuesta").intent).toBe("TICKET_PRICE");
  });
});

describe("continuidad de la conversación", () => {
  it("lee el número de personas", () => {
    expect(extractPartySize("somos 8")).toBe(8);
    expect(extractPartySize("para 6 personas")).toBe(6);
    expect(extractPartySize("hola")).toBeNull();
  });

  it("'y somos 8' después de preguntar el precio se entiende como VIP", () => {
    const routed = refineWithContext(
      routeIntent("y somos 8"),
      { lastIntent: "TICKET_PRICE", partySize: null },
      "y somos 8",
    );
    expect(routed.intent).toBe("VIP");
  });
});

describe("el motor responde el precio correcto", () => {
  it("usa el precio vigente y adjunta el CTA", async () => {
    const result = await runEngine("cuánto cuesta?", context());
    expect(result.resolvedBy).toBe("TEMPLATE");
    expect(result.text).toMatch(/20/);
    expect(result.text).not.toMatch(/15/);
    expect(result.cta?.url).toBe(CHECKOUT);
    expect(result.cta?.kind).toBe("BUY");
  });

  it("anuncia el siguiente escalón de precio", async () => {
    const result = await runEngine("cuánto cuesta?", context());
    expect(result.text).toMatch(/25/);
  });

  it("no llama al modelo para una pregunta de precio", async () => {
    const llm = new ScriptedProvider(["esto no debería usarse"]);
    const result = await runEngine("cuánto vale", context(), { llm });
    expect(result.resolvedBy).toBe("TEMPLATE");
    expect(result.llmAttempts).toBe(0);
  });
});

describe("dato caducado: mejor callar que inventar", () => {
  const stale = context({
    event: { ...context().event!, currentPrice: dp(2000, "currentPrice", 600, 1200) },
  });

  it("no afirma el precio", async () => {
    const result = await runEngine("cuánto cuesta?", stale);
    expect(result.text).not.toMatch(/20\s*€/);
  });

  it("lo dice claramente y sigue empujando al checkout", async () => {
    const result = await runEngine("cuánto cuesta?", stale);
    expect(result.text.toLowerCase()).toMatch(/no puedo confirmar/);
    expect(result.cta?.url).toBe(CHECKOUT);
  });
});

describe("disponibilidad", () => {
  it("nunca dice cuántas quedan", async () => {
    const result = await runEngine("quedan entradas?", context());
    expect(result.text).not.toMatch(/\d+\s*entradas/);
  });

  it("cuando la fuente no lo sabe, no lo afirma", async () => {
    const unknown = context({
      event: {
        ...context().event!,
        availability: dp("UNKNOWN" as const, "availability", 300, 0, 0),
      },
    });
    const result = await runEngine("quedan entradas?", unknown);
    expect(result.text.toLowerCase()).toMatch(/no te puedo confirmar/);
    expect(result.cta).not.toBeNull();
  });
});

describe("handoff humano", () => {
  it("no discute ni intenta retener", async () => {
    const result = await runEngine("quiero hablar con una persona", context());
    expect(result.requestsHandoff).toBe(true);
    expect(result.resolvedBy).toBe("HANDOFF");
  });

  it("dice la verdad cuando le preguntan si es un bot", async () => {
    const result = await runEngine("eres un bot?", context());
    expect(result.text.toLowerCase()).toMatch(/asistente|autom/);
    expect(result.text.toLowerCase()).toMatch(/equipo/);
  });
});

describe("VIP", () => {
  it("sin catálogo configurado no ofrece mesas", async () => {
    const result = await runEngine("somos 8 y queremos mesa", context());
    expect(result.text.toLowerCase()).not.toMatch(/tenemos vip/);
  });

  it("con catálogo, los precios entran en los hechos autorizados", async () => {
    const withVip = context({
      vipOptions: [
        { id: "v1", name: "VIP A", priceCents: 35_000, minPax: 6, maxPax: 10, includes: [], bookingContact: null },
      ],
    });
    const result = await runEngine("somos 8 y queremos mesa", withVip);
    expect(result.facts.amountsCents).toContain(35_000);
    expect(result.intent).toBe("VIP");
  });
});

describe("el modelo no puede saltarse el validador", () => {
  it("una respuesta con precio inventado se rechaza y cae al fallback seguro", async () => {
    const llm = new ScriptedProvider([
      "Las entradas están a 12 €, una ganga.",
      "Siguen estando a 12 €, te lo aseguro.",
    ]);
    // BIRTHDAY no tiene plantilla, así que llega al modelo.
    const result = await runEngine("puedo celebrar mi cumpleaños?", context(), { llm });
    expect(result.resolvedBy).toBe("FALLBACK");
    expect(result.llmAttempts).toBe(2);
    expect(result.text).not.toMatch(/12/);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("una respuesta correcta del modelo sí se envía", async () => {
    const llm = new ScriptedProvider(["Claro, se puede celebrar. Te paso con el equipo para organizarlo."]);
    const result = await runEngine("puedo celebrar mi cumpleaños?", context(), { llm });
    expect(result.resolvedBy).toBe("LLM");
    expect(result.llmAttempts).toBe(1);
  });

  it("sin modelo disponible responde igualmente, nunca en silencio", async () => {
    const result = await runEngine("puedo celebrar mi cumpleaños?", context(), { llm: null });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.resolvedBy).toBe("FALLBACK");
  });

  it("con el presupuesto agotado degrada a plantillas sin dejar de vender", async () => {
    const llm = new ScriptedProvider(["no debería llamarse"]);
    const result = await runEngine("cuánto cuesta?", context(), { llm, llmDisabled: true });
    expect(result.text).toMatch(/20/);
    expect(result.cta).not.toBeNull();
  });
});
