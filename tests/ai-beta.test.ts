import { describe, it, expect } from "vitest";
import { routeIntent, refineWithContext, extractPartySize, normalizeText } from "@nightlife/ai/intents";
import { detectLanguage } from "@nightlife/ai/language";
import {
  resolveAnswer,
  matchFaqs,
  scoreFaq,
  isStale,
  reasonFor,
  AUTHORITY,
  type Candidate,
} from "@nightlife/ai/knowledge";
import { resolveCheckoutUrl } from "@nightlife/core/checkout";

/**
 * Los casos de esta suite son, casi literalmente, las frases que Javier
 * escribió en la especificación. Están así a propósito: si un día alguien
 * "mejora" el router y deja de entender "q hay hoy", esto lo dice.
 */

describe("el cliente escribe como escribe", () => {
  const casos: ReadonlyArray<readonly [string, string]> = [
    ["precio?", "TICKET_PRICE"],
    ["cuánto está?", "TICKET_PRICE"],
    ["cuanto sale?", "TICKET_PRICE"],
    ["cuanto vale entrar?", "TICKET_PRICE"],
    ["precio para hoy?", "TICKET_PRICE"],
    ["cuanto esta ahora", "TICKET_PRICE"],
    ["how much tonight?", "TICKET_PRICE"],
    ["link", "BUY_TICKET"],
    ["pásame link", "BUY_TICKET"],
    ["entradas?", "BUY_TICKET"],
    ["quiero comprar", "BUY_TICKET"],
    ["tickets?", "BUY_TICKET"],
    ["pásame tickets", "BUY_TICKET"],
    ["q hay hoy", "EVENT_INFO"],
    ["qué tienes sábado", "EVENT_INFO"],
    ["hay mesas?", "VIP"],
    ["puede entrar mi colega con 17?", "AGE_REQUIREMENT"],
    ["hasta q hora puedo entrar", "OPENING_TIME"],
    ["quién pincha", "DJ_INFO"],
    ["donde es", "LOCATION"],
    ["hay entradas aun", "TICKET_AVAILABILITY"],
    ["quiero hablar con alguien", "HUMAN_AGENT"],
    ["puedo ir en shorts?", "DRESS_CODE"],
    ["puedo ir con deportivas?", "DRESS_CODE"],
    ["necesito una persona", "HUMAN_AGENT"],
    ["quiero hablar con reservas", "HUMAN_AGENT"],
  ];

  for (const [mensaje, esperado] of casos) {
    it(`«${mensaje}» → ${esperado}`, () => {
      expect(routeIntent(mensaje).intent).toBe(esperado);
    });
  }

  it("expande abreviaturas de móvil", () => {
    // Sin esto "q hay hoy" no casa con ningún patrón de `que`.
    expect(normalizeText("q hay hoy")).toBe("que hay hoy");
    expect(normalizeText("hasta q hora")).toBe("hasta que hora");
  });

  it("no confunde «cuánto costaba» con el precio de ahora", () => {
    expect(routeIntent("cuanto costaba?").intent).toBe("PRICE_HISTORY");
  });

  it("«quiero hablar con alguien» gana a «quiero comprar»", () => {
    // El orden de las reglas importa: HUMAN_AGENT va antes.
    expect(routeIntent("quiero hablar con alguien para comprar").intent).toBe("HUMAN_AGENT");
  });
});

describe("tamaño de grupo", () => {
  it("«somos 8 y queremos mesa» → VIP con 8", () => {
    expect(routeIntent("somos 8 y queremos mesa").intent).toBe("VIP");
    expect(extractPartySize("somos 8 y queremos mesa")).toBe(8);
  });

  it("«y somos 8» a secas se interpreta con el contexto", () => {
    const bruto = routeIntent("y somos 8");
    const refinado = refineWithContext(bruto, { lastIntent: "TICKET_PRICE", partySize: null }, "y somos 8");
    expect(refinado.intent).toBe("VIP");
  });

  it("no inventa un grupo donde no lo hay", () => {
    expect(extractPartySize("cuanto cuesta")).toBe(null);
  });
});

describe("idioma: se responde en el del mensaje", () => {
  it("«precio para hoy?» → español", () => {
    expect(detectLanguage("precio para hoy?").lang).toBe("es");
  });

  it("«How much is it tonight?» → inglés", () => {
    expect(detectLanguage("How much is it tonight?").lang).toBe("en");
  });

  it("«can i wear sneakers?» → inglés", () => {
    expect(detectLanguage("can i wear sneakers?").lang).toBe("en");
  });

  it("un mensaje sin señal mantiene el idioma anterior", () => {
    // Cambiar de idioma porque alguien escribió "ok" sería peor que no
    // cambiarlo nunca.
    const g = detectLanguage("ok", "en");
    expect(g.lang).toBe("en");
    expect(g.confident).toBe(false);
  });

  it("una tilde basta para decidir español", () => {
    expect(detectLanguage("dónde").lang).toBe("es");
  });
});

describe("FAQs por significado, no por letra", () => {
  const dressCode = {
    id: "faq1",
    question: "¿Puedo entrar con pantalón corto?",
    answer: "No se permite pantalón corto ni ropa deportiva.",
    intent: "DRESS_CODE",
  };
  const horario = {
    id: "faq2",
    question: "¿A qué hora abrís?",
    answer: "Abrimos a las 23:30.",
    intent: "OPENING_TIME",
  };

  it("«puedo ir en shorts?» encuentra la FAQ del pantalón corto", () => {
    const m = matchFaqs("puedo ir en shorts?", [dressCode, horario], { intent: "DRESS_CODE" });
    expect(m[0]?.faq.id).toBe("faq1");
  });

  it("«puedo ir con deportivas?» también", () => {
    const m = matchFaqs("puedo ir con deportivas?", [dressCode, horario], { intent: "DRESS_CODE" });
    expect(m[0]?.faq.id).toBe("faq1");
  });

  it("«a qué hora abrís» NO trae la del dress code", () => {
    const m = matchFaqs("a que hora abris", [dressCode, horario], { intent: "OPENING_TIME" });
    expect(m[0]?.faq.id).toBe("faq2");
  });

  it("una pregunta que no tiene nada que ver no casa con ninguna", () => {
    const m = matchFaqs("hay parking cerca", [dressCode, horario]);
    expect(m.length).toBe(0);
  });

  it("coincidir en intent sube la puntuación", () => {
    const con = scoreFaq("puedo ir en shorts", dressCode, "DRESS_CODE");
    const sin = scoreFaq("puedo ir en shorts", dressCode);
    expect(con).toBeGreaterThan(sin);
  });
});

describe("orden de autoridad", () => {
  const ahora = new Date("2026-08-23T20:00:00Z");
  const base = { sourceId: "x", lastUpdated: ahora, ttlSeconds: null } as const;

  it("Fourvenues gana a todo", () => {
    const r = resolveAnswer({
      candidates: [
        { ...base, sourceType: "CLUB_KNOWLEDGE", sourceField: "price", text: "20€" },
        { ...base, sourceType: "FOURVENUES", sourceField: "price", text: "25€" },
      ],
      intent: "TICKET_PRICE",
      hasClubContext: true,
      now: ahora,
    });
    expect(r?.candidate.text).toBe("25€");
    expect(r?.authority).toBe(AUTHORITY.LIVE);
  });

  it("lo específico del evento gana a la norma general del club", () => {
    // MON es +18, pero el 29 de agosto es +21. La respuesta correcta es +21.
    const r = resolveAnswer({
      candidates: [
        { ...base, sourceType: "CLUB_KNOWLEDGE", sourceField: "minAge", text: "+18" },
        { ...base, sourceType: "EVENT_OVERRIDE", sourceField: "minAge", text: "+21" },
      ],
      intent: "AGE_REQUIREMENT",
      hasClubContext: true,
      now: ahora,
    });
    expect(r?.candidate.text).toBe("+21");
  });

  it("un RRPP NO puede sobrescribir el dress code de un club", () => {
    // El caso literal de la especificación: MON dice que no a la ropa
    // deportiva, el RRPP tiene una FAQ que dice que normalmente sí.
    const r = resolveAnswer({
      candidates: [
        { ...base, sourceType: "PROMOTER_KNOWLEDGE", sourceField: "dressCode", text: "normalmente puedes ir con deportivas" },
        { ...base, sourceType: "CLUB_KNOWLEDGE", sourceField: "dressCode", text: "No se permite ropa deportiva" },
      ],
      intent: "DRESS_CODE",
      hasClubContext: true,
      now: ahora,
    });
    expect(r?.candidate.text).toBe("No se permite ropa deportiva");
  });

  it("y no la sobrescribe ni aunque el club no tenga nada que decir", () => {
    // Que el club no lo haya configurado no convierte al RRPP en autoridad
    // sobre las normas del club. Mejor no responder.
    const r = resolveAnswer({
      candidates: [
        { ...base, sourceType: "PROMOTER_KNOWLEDGE", sourceField: "dressCode", text: "yo creo que sí" },
      ],
      intent: "DRESS_CODE",
      hasClubContext: true,
      now: ahora,
    });
    expect(r).toBe(null);
  });

  it("pero SÍ responde de lo suyo cuando no hay club de por medio", () => {
    const r = resolveAnswer({
      candidates: [
        { ...base, sourceType: "PROMOTER_KNOWLEDGE", sourceField: "howToBuy", text: "escríbeme y te paso el link" },
      ],
      intent: "BUY_TICKET",
      hasClubContext: false,
      now: ahora,
    });
    expect(r?.candidate.text).toBe("escríbeme y te paso el link");
  });

  it("sin ninguna fuente devuelve null, que es lo que dispara la pregunta sin respuesta", () => {
    const r = resolveAnswer({ candidates: [], intent: "TICKET_PRICE", hasClubContext: true, now: ahora });
    expect(r).toBe(null);
  });
});

describe("frescura: no afirmar un precio caducado", () => {
  const ahora = new Date("2026-08-23T20:00:00Z");
  const viejo = new Date("2026-08-20T20:00:00Z"); // tres días

  it("un dato vivo caducado no se afirma", () => {
    const r = resolveAnswer({
      candidates: [
        { sourceType: "FOURVENUES", sourceId: "e1", sourceField: "price", text: "20€", lastUpdated: viejo, ttlSeconds: 3600 },
      ],
      intent: "TICKET_PRICE",
      hasClubContext: true,
      now: ahora,
    });
    expect(r).toBe(null);
  });

  it("un dato sin TTL no caduca: una dirección es una dirección", () => {
    const c: Candidate = {
      sourceType: "CLUB_KNOWLEDGE", sourceId: "c1", sourceField: "address",
      text: "Calle X, 1", lastUpdated: viejo, ttlSeconds: null,
    };
    expect(isStale(c, ahora)).toBe(false);
  });

  it("un dato vivo caducado pierde contra uno estático vigente", () => {
    const r = resolveAnswer({
      candidates: [
        { sourceType: "FOURVENUES", sourceId: "e1", sourceField: "dressCode", text: "libre", lastUpdated: viejo, ttlSeconds: 3600 },
        { sourceType: "CLUB_KNOWLEDGE", sourceId: "c1", sourceField: "dressCode", text: "No deportivas", lastUpdated: viejo, ttlSeconds: null },
      ],
      intent: "DRESS_CODE",
      hasClubContext: true,
      now: ahora,
    });
    expect(r?.candidate.text).toBe("No deportivas");
  });

  it("distingue por qué no pudo responder", () => {
    const ahora2 = new Date("2026-08-23T20:00:00Z");
    expect(reasonFor({ candidates: [], intent: "TICKET_PRICE", hasClubContext: true, now: ahora2 })).toBe("NO_DATA");
    expect(
      reasonFor({
        candidates: [{ sourceType: "FOURVENUES", sourceId: "e", sourceField: "price", text: "20", lastUpdated: viejo, ttlSeconds: 60 }],
        intent: "TICKET_PRICE", hasClubContext: true, now: ahora2,
      }),
    ).toBe("STALE_DATA");
    expect(
      reasonFor({ candidates: [], intent: "TICKET_PRICE", hasClubContext: true, now: ahora2, ambiguousOptions: 3 }),
    ).toBe("AMBIGUOUS");
  });
});

describe("a qué Fourvenues manda el botón de comprar", () => {
  const evento = "https://fourvenues.com/mon/events/abc";
  const promoterEvento = "https://fourvenues.com/mon/events/abc?p=javi";
  const promoterGlobal = "https://fourvenues.com/javi";

  it("PROMOTER: su URL específica del evento gana", () => {
    const r = resolveCheckoutUrl({
      clubCheckoutUrl: evento,
      promoterCheckoutUrl: promoterEvento,
      promoterGlobalUrl: promoterGlobal,
    });
    expect(r.url).toBe(promoterEvento);
    expect(r.source).toBe("PROMOTER");
  });

  it("sin URL específica cae en la del evento", () => {
    const r = resolveCheckoutUrl({ clubCheckoutUrl: evento, promoterGlobalUrl: promoterGlobal });
    expect(r.url).toBe(evento);
    expect(r.source).toBe("CLUB");
  });

  it("sin evento cae en el link global del RRPP", () => {
    const r = resolveCheckoutUrl({ promoterGlobalUrl: promoterGlobal });
    expect(r.url).toBe(promoterGlobal);
    expect(r.source).toBe("PROMOTER_GLOBAL");
  });

  it("sin nada NO se inventa una URL", () => {
    const r = resolveCheckoutUrl({});
    expect(r.url).toBe(null);
    expect(r.source).toBe("NONE");
  });

  it("un enlace que no es de Fourvenues por https no cuela", () => {
    const r = resolveCheckoutUrl({ clubCheckoutUrl: "http://inseguro.com/x" });
    expect(r.url).toBe(null);
  });
});
