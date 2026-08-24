/**
 * Intents y router determinista (capa L0).
 *
 * Una parte grande de las preguntas de nightlife son literalmente las mismas
 * cinco frases. Resolverlas con patrones cuesta cero, responde en
 * milisegundos y no puede alucinar. El LLM se reserva para lo que de verdad
 * necesita lenguaje.
 */

export const INTENTS = [
  "TICKET_PRICE",
  "PRICE_HISTORY", // "¿cuánto costaba?" — se responde con el histórico
  "PRICE_FUTURE", // "¿cuánto costará?" — casi siempre "no lo sé todavía"
  "TICKET_AVAILABILITY",
  "BUY_TICKET",
  "EVENT_INFO",
  "EVENT_DATE",
  "EVENT_TIME",
  "DJ_INFO",
  "LOCATION",
  "OPENING_TIME",
  "AGE_REQUIREMENT",
  "DRESS_CODE",
  "VIP",
  "TABLE_RESERVATION",
  "BIRTHDAY",
  "GUEST_LIST",
  "FAQ",
  "HUMAN_AGENT",
  "IS_BOT", // "¿eres un bot?" — hay que decir la verdad
  "GREETING",
  "OTHER",
] as const;

export type Intent = (typeof INTENTS)[number];

/** Intents con intención de compra: disparan el CTA de inmediato. */
export const PURCHASE_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "BUY_TICKET",
  "TICKET_PRICE",
  "TICKET_AVAILABILITY",
  "VIP",
  "TABLE_RESERVATION",
  "GUEST_LIST",
]);

/**
 * Abreviaturas de móvil. La gente no escribe "qué" en un DM de Instagram,
 * escribe "q". Sin esto, "q hay hoy" no casa con ningún patrón de `que` y se
 * va al LLM —o peor, a OTHER— por una letra.
 *
 * Solo se expanden palabras completas: "que" dentro de "queso" se queda.
 */
const ABREVIATURAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bq\b/g, "que"],
  [/\bk\b/g, "que"],
  [/\bqe\b/g, "que"],
  [/\bxq\b/g, "porque"],
  [/\bpq\b/g, "porque"],
  [/\bxfa\b/g, "por favor"],
  [/\bpf\b/g, "por favor"],
  [/\btb\b/g, "tambien"],
  [/\btmb\b/g, "tambien"],
  [/\bx\b/g, "por"],
  [/\bd\b/g, "de"],
  [/\bpa\b/g, "para"],
  [/\bdnd\b/g, "donde"],
  [/\bcuanto?s?\b/g, "cuanto"],
  [/\bentras\b/g, "entrar"],
  [/\bu\b/g, "you"],
  [/\br\b/g, "are"],
];

export function normalizeText(input: string): string {
  let text = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, replacement] of ABREVIATURAS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}

interface Rule {
  readonly intent: Intent;
  readonly patterns: readonly RegExp[];
}

// El orden importa: lo más específico primero. "cuanto costaba" tiene que
// ganar a "cuanto cuesta", y "quiero hablar con alguien" a "quiero".
const RULES: readonly Rule[] = [
  {
    intent: "IS_BOT",
    patterns: [/\beres (un )?(bot|robot|maquina|ia|inteligencia artificial)\b/, /\bhablo con (una )?persona\b/, /\besto es (un )?bot\b/],
  },
  {
    intent: "HUMAN_AGENT",
    patterns: [
      /\bhablar con (alguien|una persona|un humano|el equipo|rrpp|reservas)\b/,
      /\bme pas(as|a|ais) con\b/,
      /\bquiero (hablar|contactar) con\b/,
      /\bnecesito (una persona|hablar|que me atienda)\b/,
      /\batencion (al )?cliente\b/,
      /\bhay alguien (ahi|que me atienda)\b/,
      /\b(talk|speak) to (someone|a person|a human|somebody)\b/,
      /\breal person\b/,
    ],
  },
  {
    intent: "PRICE_HISTORY",
    patterns: [/\bcuanto (costaba|valia|era|estaba)\b/, /\bprecio (anterior|de antes|inicial)\b/],
  },
  {
    intent: "PRICE_FUTURE",
    patterns: [
      /\bcuanto (costara|valdra|va a (costar|valer))\b/,
      /\bcuando sube\b/,
      /\bva a subir\b/,
      /\bproximo (precio|release)\b/,
    ],
  },
  {
    intent: "TICKET_PRICE",
    patterns: [
      /\bcuanto (cuesta|vale|es|sale|esta|cobran|piden)\b/,
      /\bque precio\b/,
      /\bprecio(s)?\b/,
      /\bcuanto (por|la) entrada\b/,
      /\bcuanto vale entrar\b/,
      /\bcuanto\b.*\bentra/,
      // «cuánto?» a secas, o al final de la frase: «la de MON, cuánto?».
      // Anclado al final a propósito: así «cuánto tiempo lleváis abiertos»
      // no se convierte en una pregunta de precio.
      /\bcuanto\s*$/,
      /\bhow much\b/,
      /\bwhat.s the price\b/,
      /\bprice\b/,
      /\bcover charge\b/,
    ],
  },
  {
    intent: "TICKET_AVAILABILITY",
    patterns: [
      /\bquedan (entradas|tickets|plazas|sitios)\b/,
      /\bhay entradas (aun|todavia)?\b/,
      /\bestan agotadas\b/,
      /\bsold ?out\b/,
      /\bentradas en (la )?puerta\b/,
      /\bse puede (comprar|entrar) en (la )?puerta\b/,
      /\bany tickets (left|available)\b/,
      /\bstill available\b/,
    ],
  },
  {
    intent: "BUY_TICKET",
    patterns: [
      /\b(quiero|queria|quisiera) (comprar|coger|pillar|sacar)\b/,
      /\bdonde (compro|se compra|las compro)\b/,
      /\bcomo (compro|las saco)\b/,
      /\blink\b/,
      /\benlace\b/,
      /\bpasame\b.*\b(link|entradas|tickets|enlace)\b/,
      /\bmandame\b.*\b(link|entradas|tickets|enlace)\b/,
      /^\s*entradas\s*$/,
      /^\s*tickets?\s*$/,
      /\bbuy (a )?ticket/,
      /\bwhere (do i|can i) buy\b/,
      /\bsend me the link\b/,
    ],
  },
  {
    intent: "VIP",
    patterns: [
      /\bvip\b/, /\breservado\b/, /\bbotella\b/, /\bmesa(s)?\b/,
      /\bzona privada\b/, /\btable(s)?\b/, /\bbottle service\b/,
    ],
  },
  {
    intent: "TABLE_RESERVATION",
    patterns: [/\breservar (una )?mesa\b/, /\breserva de mesa\b/],
  },
  {
    intent: "BIRTHDAY",
    patterns: [/\bcumple(anos)?\b/, /\bcelebrar\b/, /\bdespedida\b/, /\bbirthday\b/],
  },
  {
    intent: "GUEST_LIST",
    patterns: [/\blista\b/, /\bguest ?list\b/, /\bapuntarme\b/, /\bponerme en lista\b/, /\bon the list\b/],
  },
  {
    intent: "DJ_INFO",
    patterns: [
      /\bquien (pincha|toca|viene|esta)\b/,
      /\bque dj\b/,
      /\bcartel\b/,
      /\bline ?up\b/,
      /\bartista\b/,
      /\bwho.s (playing|on|djing)\b/,
    ],
  },
  {
    intent: "AGE_REQUIREMENT",
    patterns: [
      /\bedad\b/,
      /\bmenores\b/,
      /\bmayores de\b/,
      /\btengo \d{2}( anos)?\b/,
      /\bcon \d{2}\b.*\b(puedo|puede|entrar|entra)\b/,
      /\b(puedo|puede)\b.*\bcon \d{2}\b/,
      /\bage (limit|requirement)\b/,
      /\bhow old\b/,
      /\bunder ?ages?\b/,
    ],
  },
  {
    intent: "DRESS_CODE",
    patterns: [
      /\bdress ?code\b/,
      /\bcomo (hay que )?ir vestid/,
      /\b(puedo|puedes|podemos|se puede) (ir|entrar) (con|en)\b/,
      /\bzapatillas\b/,
      /\bdeportivas\b/,
      /\bchandal\b/,
      /\bshorts\b/,
      /\bvestimenta\b/,
      /\bcan i wear\b/,
      /\bsneakers\b/,
    ],
  },
  {
    intent: "OPENING_TIME",
    patterns: [
      /\ba que hora (abre|abris|empieza|cierra|cerrais)\b/,
      /\bhorario\b/,
      /\bhasta que hora\b/,
      /\bultima hora (de entrada|para entrar)\b/,
      /\bwhat time (do you )?(open|close)\b/,
      /\bopening (time|hours)\b/,
      /\bhow late\b/,
    ],
  },
  {
    intent: "LOCATION",
    patterns: [
      /\bdonde (esta|estais|queda|es)\b/,
      /\bdireccion\b/,
      /\bcomo (llego|se llega)\b/,
      /\bubicacion\b/,
      /\ben que calle\b/,
      /\bwhere (is|are you)\b/,
      /\baddress\b/,
    ],
  },
  {
    intent: "EVENT_DATE",
    patterns: [
      /\bque dia\b/,
      /\bque fecha\b/,
      /\bcuando es\b/,
      /\bwhat day\b/,
      /\bwhat date\b/,
    ],
  },
  {
    intent: "EVENT_TIME",
    patterns: [/\ba que hora (es|empieza)\b/, /\bhora del evento\b/],
  },
  {
    intent: "EVENT_INFO",
    patterns: [
      /\bque (fiesta|evento|hay|tienes|teneis|hacéis|haceis)\b/,
      /\bque plan\b/,
      /\bprograma\b/,
      /\beste (sabado|viernes|jueves|domingo|finde)\b/,
      /\bwhat.s (on|happening|going on)\b/,
      /\bany (party|parties|events?)\b/,
    ],
  },
  {
    intent: "GREETING",
    patterns: [/^(hola|buenas|hey|holi|ey|wenas|hi|hello|buenos dias|buenas tardes|buenas noches)\b/],
  },
];

export interface RouteResult {
  readonly intent: Intent;
  /** true cuando lo ha decidido una regla y no hace falta gastar en el clasificador. */
  readonly confident: boolean;
  readonly matchedPattern?: string;
}

export function routeIntent(rawText: string): RouteResult {
  const text = normalizeText(rawText);
  if (text.length === 0) return { intent: "OTHER", confident: false };

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { intent: rule.intent, confident: true, matchedPattern: pattern.source };
      }
    }
  }
  return { intent: "OTHER", confident: false };
}

/**
 * Número de personas mencionado. "somos 8", "para 6", "vamos 12".
 * Es lo que convierte "y somos 8" tras una pregunta de precio en una consulta
 * de VIP sin que el cliente tenga que repetir nada.
 */
export function extractPartySize(rawText: string): number | null {
  const text = normalizeText(rawText);
  const patterns = [
    /\bsomos (\d{1,3})\b/,
    /\bpara (\d{1,3}) (personas|pax|gente|tios|tias)\b/,
    /\bvamos (\d{1,3})\b/,
    /\bseriamos (\d{1,3})\b/,
    /\bgrupo de (\d{1,3})\b/,
    /\b(\d{1,3}) personas\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (n >= 1 && n <= 200) return n;
    }
  }
  return null;
}

/**
 * Reinterpreta el intent con lo que ya sabemos de la conversación.
 * "y somos 8" a secas es OTHER; después de hablar de precios es VIP.
 */
export function refineWithContext(
  route: RouteResult,
  context: { lastIntent?: Intent | null; partySize?: number | null },
  message: string,
): RouteResult {
  const partySize = extractPartySize(message);

  if (route.intent === "OTHER" && partySize !== null && partySize >= 4) {
    return { intent: "VIP", confident: true, matchedPattern: "context:partySize" };
  }
  if (route.intent === "OTHER" && context.lastIntent && /^(si|vale|ok|perfecto|dale|va)$/.test(normalizeText(message))) {
    return { intent: context.lastIntent, confident: true, matchedPattern: "context:continuation" };
  }
  return route;
}
