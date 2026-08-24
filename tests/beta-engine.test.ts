import { describe, it, expect } from "vitest";
import { decide, contextUpdateFor, resolveClubReference, type ConversationState, type DecisionInput } from "@nightlife/ai/beta-engine";
import type { Candidate, FaqLike } from "@nightlife/ai/knowledge";

const AHORA = new Date("2026-08-23T20:00:00Z");

const estadoBase: ConversationState = { status: "AI_ACTIVE" };

function entrada(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    message: "hola",
    state: estadoBase,
    autoReply: true,
    candidates: [],
    faqs: [],
    llmAvailable: true,
    now: AHORA,
    ...over,
  };
}

const precioVivo: Candidate = {
  sourceType: "FOURVENUES",
  sourceId: "ev1",
  sourceField: "price",
  text: "20€",
  lastUpdated: AHORA,
  ttlSeconds: 3600,
};

describe("la IA se calla cuando debe", () => {
  it("con un humano dentro no responde", () => {
    const d = decide(entrada({ message: "cuanto cuesta", state: { ...estadoBase, status: "HUMAN_ACTIVE" } }));
    expect(d.kind).toBe("SILENT");
    if (d.kind === "SILENT") expect(d.reason).toBe("HUMAN_ACTIVE");
  });

  it("con la conversación cerrada tampoco", () => {
    const d = decide(entrada({ state: { ...estadoBase, status: "CLOSED" } }));
    expect(d.kind).toBe("SILENT");
  });

  it("con autoReply apagado el mensaje entra pero la IA no contesta", () => {
    const d = decide(entrada({ message: "cuanto cuesta", autoReply: false, candidates: [precioVivo] }));
    expect(d.kind).toBe("SILENT");
    if (d.kind === "SILENT") expect(d.reason).toBe("AUTOREPLY_OFF");
  });

  it("y vuelve a hablar cuando la conversación regresa a la IA", () => {
    const d = decide(entrada({ message: "cuanto cuesta", candidates: [precioVivo], state: { ...estadoBase, status: "AI_ACTIVE", eventFocusId: "ev1" } }));
    expect(d.kind).toBe("ANSWER");
  });
});

describe("handoff humano", () => {
  it("«quiero hablar con alguien» pasa a humano", () => {
    const d = decide(entrada({ message: "quiero hablar con alguien" }));
    expect(d.kind).toBe("HANDOFF");
    if (d.kind === "HANDOFF") expect(d.reason).toBe("REQUESTED");
  });

  it("una mesa sin información configurada también, en vez de inventarse un precio", () => {
    const d = decide(entrada({ message: "somos 10 y queremos mesa" }));
    expect(d.kind).toBe("HANDOFF");
    if (d.kind === "HANDOFF") expect(d.reason).toBe("NEEDS_HUMAN");
  });

  it("pero si el club SÍ tiene información de mesas, responde", () => {
    const d = decide(
      entrada({
        message: "hay mesas?",
        candidates: [
          { sourceType: "CLUB_KNOWLEDGE", sourceId: "k1", sourceField: "vip", text: "Reservados desde 300€", ttlSeconds: null },
        ],
        state: { ...estadoBase, contextClubId: "club_mon" },
      }),
    );
    expect(d.kind).toBe("ANSWER");
  });
});

describe("no inventar", () => {
  it("sin datos genera una pregunta sin respuesta, no una respuesta", () => {
    const d = decide(entrada({ message: "hay descuento de cumpleanos si somos 12", state: { ...estadoBase, eventFocusId: "ev1" } }));
    // BIRTHDAY sin datos va a handoff; lo que no puede es inventarse nada.
    expect(["UNANSWERED", "HANDOFF"]).toContain(d.kind);
  });

  it("una pregunta rara sin fuente se guarda para que la conteste un humano", () => {
    const d = decide(entrada({ message: "hay parking cerca del sitio", state: { ...estadoBase, eventFocusId: "ev1" } }));
    expect(d.kind).toBe("UNANSWERED");
    if (d.kind === "UNANSWERED") expect(d.reason).toBe("NO_DATA");
  });

  it("un precio caducado no se afirma: se guarda como dato viejo", () => {
    const viejo: Candidate = { ...precioVivo, lastUpdated: new Date("2026-08-20T20:00:00Z") };
    const d = decide(entrada({ message: "precio?", candidates: [viejo], state: { ...estadoBase, eventFocusId: "ev1" } }));
    expect(d.kind).toBe("UNANSWERED");
    if (d.kind === "UNANSWERED") expect(d.reason).toBe("STALE_DATA");
  });

  it("sin clave de LLM y sin datos no se finge un asistente", () => {
    const d = decide(entrada({ message: "que tal el ambiente", llmAvailable: false, state: { ...estadoBase, eventFocusId: "ev1" } }));
    expect(d.kind).toBe("UNANSWERED");
    if (d.kind === "UNANSWERED") expect(d.reason).toBe("NO_LLM");
  });
});

describe("ambigüedad: preguntar solo lo mínimo", () => {
  it("con un solo evento responde directamente", () => {
    const d = decide(
      entrada({
        message: "precio?",
        candidates: [precioVivo],
        eventOptions: [{ id: "ev1", label: "MON sábado" }],
      }),
    );
    expect(d.kind).toBe("ANSWER");
  });

  it("con tres eventos y ninguno elegido, pregunta cuál", () => {
    const d = decide(
      entrada({
        message: "precio?",
        candidates: [precioVivo],
        eventOptions: [
          { id: "ev1", label: "MON sábado" },
          { id: "ev2", label: "Liberata sábado" },
          { id: "ev3", label: "MON domingo" },
        ],
      }),
    );
    expect(d.kind).toBe("CLARIFY");
    if (d.kind === "CLARIFY") {
      expect(d.field).toBe("event");
      expect(d.options.length).toBe(3);
    }
  });

  it("una vez elegido el evento, ya no vuelve a preguntar", () => {
    const d = decide(
      entrada({
        message: "precio?",
        candidates: [precioVivo],
        state: { ...estadoBase, eventFocusId: "ev1" },
        eventOptions: [
          { id: "ev1", label: "MON sábado" },
          { id: "ev2", label: "Liberata sábado" },
        ],
      }),
    );
    expect(d.kind).toBe("ANSWER");
  });
});

describe("contexto multi-turno", () => {
  const clubs = [
    { id: "club_mon", label: "MON" },
    { id: "club_lib", label: "Liberata" },
  ];

  it("«la de MON» selecciona MON", () => {
    expect(resolveClubReference("la de MON", clubs)).toBe("club_mon");
  });

  it("«liberata» selecciona Liberata", () => {
    expect(resolveClubReference("liberata porfa", clubs)).toBe("club_lib");
  });

  it("un mensaje sin nombre de club no cambia el contexto", () => {
    expect(resolveClubReference("cuanto cuesta", clubs)).toBe(null);
  });

  it("el turno guarda intent, idioma y contexto — nunca el dueño", () => {
    const d = decide(entrada({ message: "la de MON, cuanto?", candidates: [precioVivo], state: { ...estadoBase, eventFocusId: "ev1" } }));
    const u = contextUpdateFor({ decision: d, message: "la de MON, cuanto?", clubOptions: clubs });
    expect(u.contextClubId).toBe("club_mon");
    expect(u.lastIntent).toBe("TICKET_PRICE");
    expect(u.purchaseIntent).toBe(true);
    // Lo que importa: aquí no hay ni ownerType ni ownerClubId. El dueño es
    // inmutable y no se toca desde la aplicación.
    expect(Object.keys(u)).not.toContain("ownerType");
    expect(Object.keys(u)).not.toContain("ownerClubId");
    expect(Object.keys(u)).not.toContain("ownerPromoterId");
  });

  it("recuerda el tamaño del grupo entre turnos", () => {
    const d = decide(entrada({ message: "somos 8", state: { ...estadoBase, lastIntent: "TICKET_PRICE" } }));
    const u = contextUpdateFor({ decision: d, message: "somos 8" });
    expect(u.partySize).toBe(8);
  });
});

describe("el RRPP no habla por el club", () => {
  const faqPromoter: FaqLike = {
    id: "promoter:f1",
    question: "¿Puedo ir con deportivas?",
    answer: "Normalmente puedes ir con deportivas",
    intent: "DRESS_CODE",
  };
  const conocimientoClub: Candidate = {
    sourceType: "CLUB_KNOWLEDGE",
    sourceId: "k1",
    sourceField: "dressCode",
    text: "No se permite ropa deportiva",
    ttlSeconds: null,
  };

  it("hablando de MON gana el dress code de MON", () => {
    const d = decide(
      entrada({
        message: "puedo ir con deportivas?",
        faqs: [faqPromoter],
        candidates: [conocimientoClub],
        state: { ...estadoBase, contextClubId: "club_mon" },
      }),
    );
    expect(d.kind).toBe("ANSWER");
    if (d.kind === "ANSWER") expect(d.resolved.candidate.text).toBe("No se permite ropa deportiva");
  });

  it("y si el club no lo tiene configurado, prefiere no responder", () => {
    const d = decide(
      entrada({
        message: "puedo ir con deportivas?",
        faqs: [faqPromoter],
        state: { ...estadoBase, contextClubId: "club_mon" },
      }),
    );
    expect(d.kind).toBe("UNANSWERED");
  });

  it("pero sí responde de lo suyo cuando no se habla de ningún club", () => {
    const suyo: FaqLike = {
      id: "promoter:f2",
      question: "¿Cómo te compro?",
      answer: "Escríbeme por aquí y te paso el link",
      intent: "BUY_TICKET",
    };
    const d = decide(
      entrada({ message: "como te compro?", faqs: [suyo], state: { ...estadoBase, eventFocusId: "ev1" } }),
    );
    expect(d.kind).toBe("ANSWER");
  });
});

describe("idioma de la respuesta", () => {
  it("pregunta en español → respuesta marcada como española", () => {
    const d = decide(entrada({ message: "precio?", candidates: [precioVivo], state: { ...estadoBase, eventFocusId: "ev1" } }));
    if (d.kind === "ANSWER") expect(d.lang).toBe("es");
  });

  it("pregunta en inglés → respuesta marcada como inglesa", () => {
    const d = decide(entrada({ message: "how much tonight?", candidates: [precioVivo], state: { ...estadoBase, eventFocusId: "ev1" } }));
    if (d.kind === "ANSWER") expect(d.lang).toBe("en");
  });

  it("el idioma del panel no manda: manda el del mensaje", () => {
    const d = decide(
      entrada({
        message: "how much is it tonight?",
        candidates: [precioVivo],
        state: { ...estadoBase, locale: "es", eventFocusId: "ev1" },
      }),
    );
    if (d.kind === "ANSWER") expect(d.lang).toBe("en");
  });
});

describe("CTA de compra", () => {
  it("una pregunta de precio enseña el botón", () => {
    const d = decide(entrada({ message: "precio?", candidates: [precioVivo], state: { ...estadoBase, eventFocusId: "ev1" } }));
    if (d.kind === "ANSWER") expect(d.showBuyCta).toBe(true);
  });

  it("una pregunta de ubicación no", () => {
    const d = decide(
      entrada({
        message: "donde es?",
        candidates: [{ sourceType: "CLUB_KNOWLEDGE", sourceId: "k", sourceField: "address", text: "Calle X", ttlSeconds: null }],
        state: { ...estadoBase, contextClubId: "club_mon" },
      }),
    );
    if (d.kind === "ANSWER") expect(d.showBuyCta).toBe(false);
  });
});
