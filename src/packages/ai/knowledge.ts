import type { Intent } from "./intents";
import { normalizeText } from "./intents";

/**
 * De dónde puede salir una respuesta, y cuál gana.
 *
 * Este archivo es el que impide las dos cosas que hundirían el producto:
 * que la IA se invente un dato, y que el conocimiento de un RRPP contradiga
 * las reglas oficiales de un club.
 *
 * No habla con la base de datos ni con el LLM. Recibe candidatos ya
 * cargados y decide. Así se puede probar entero sin levantar nada.
 */

/**
 * Orden de autoridad. El número bajo gana.
 *
 * No es una preferencia estética: es la diferencia entre decirle a un
 * cliente el precio de verdad o el que alguien escribió a mano hace tres
 * meses. Los datos vivos de Fourvenues ganan siempre, y lo específico de un
 * evento gana a la norma general del club — si MON es +18 pero el 29 de
 * agosto es +21, la respuesta al «qué edad piden el 29» es +21.
 */
export const AUTHORITY = {
  LIVE: 1, // Fourvenues / datos de evento en vivo
  EVENT_OVERRIDE: 2, // información específica de ese evento
  CLUB_KNOWLEDGE: 3, // reglas oficiales del club
  PROMOTER_KNOWLEDGE: 4, // lo que añade el RRPP
  CONVERSATION: 5, // lo que se dijo antes en esta conversación
} as const;

export type AuthorityLevel = (typeof AUTHORITY)[keyof typeof AUTHORITY];

export type SourceType =
  | "FOURVENUES"
  | "EVENT_OVERRIDE"
  | "CLUB_KNOWLEDGE"
  | "PROMOTER_KNOWLEDGE"
  | "CONVERSATION";

const LEVEL_OF: Record<SourceType, AuthorityLevel> = {
  FOURVENUES: AUTHORITY.LIVE,
  EVENT_OVERRIDE: AUTHORITY.EVENT_OVERRIDE,
  CLUB_KNOWLEDGE: AUTHORITY.CLUB_KNOWLEDGE,
  PROMOTER_KNOWLEDGE: AUTHORITY.PROMOTER_KNOWLEDGE,
  CONVERSATION: AUTHORITY.CONVERSATION,
};

/**
 * Un dato con su procedencia. Todo lo que la IA puede afirmar viene envuelto
 * así: sin `sourceType` no hay respuesta, y por tanto no hay invención
 * posible.
 */
export interface Candidate {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  /** Qué campo o pregunta cubre: "price", "dressCode", "minAge", "faq:xyz". */
  readonly sourceField: string;
  readonly text: string;
  /** Cuándo se supo. Para datos vivos, cuándo se sincronizó. */
  readonly lastUpdated?: Date | null;
  /** Segundos de validez. null = no caduca (una dirección no caduca). */
  readonly ttlSeconds?: number | null;
  readonly confidence?: number;
  /** Palabras que ayudan a emparejar una FAQ con la pregunta. */
  readonly keywords?: readonly string[];
  /** El intent que esta fuente sabe responder, si es específico. */
  readonly intent?: Intent | null;
}

export interface ResolvedAnswer {
  readonly candidate: Candidate;
  readonly authority: AuthorityLevel;
  readonly stale: boolean;
}

/** ¿Ha caducado? Sin `ttlSeconds` no caduca; sin `lastUpdated` sí. */
export function isStale(c: Candidate, now: Date): boolean {
  if (c.ttlSeconds === null || c.ttlSeconds === undefined) return false;
  if (!c.lastUpdated) return true;
  const age = (now.getTime() - c.lastUpdated.getTime()) / 1000;
  return age > c.ttlSeconds;
}

/**
 * Reglas del club que un RRPP no puede tocar.
 *
 * Un RRPP puede decir cómo comprarle a él, dar su teléfono o explicar su
 * lista. No puede decir que en MON se entra con deportivas si MON dice que
 * no: eso no es "su información", es contradecir al negocio en su nombre.
 *
 * La comprobación se hace por campo, no por confianza en nadie.
 */
export const CLUB_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "minAge",
  "dressCode",
  "openingHours",
  "lastEntry",
  "address",
  "location",
  "policies",
  "vip",
  "tables",
  "capacity",
]);

/** Los intents cuya respuesta es competencia exclusiva del club. */
export const CLUB_OWNED_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "AGE_REQUIREMENT",
  "DRESS_CODE",
  "OPENING_TIME",
  "LOCATION",
]);

/**
 * Elige la mejor fuente para responder.
 *
 * Devuelve `null` cuando no hay ninguna utilizable — y eso NO es un fallo:
 * es la señal de que hay que guardar una pregunta sin respuesta en vez de
 * inventarse algo.
 */
export function resolveAnswer(args: {
  readonly candidates: readonly Candidate[];
  readonly intent: Intent;
  /** Hay contexto de club cuando se sabe de qué club se habla. */
  readonly hasClubContext: boolean;
  readonly now: Date;
}): ResolvedAnswer | null {
  const { candidates, intent, hasClubContext, now } = args;

  const usable = candidates.filter((c) => {
    // Un RRPP no puede responder por el club en las materias del club.
    // Solo aplica cuando hay club de por medio: si la pregunta no va de
    // ningún club, el RRPP responde de lo suyo con normalidad.
    if (
      c.sourceType === "PROMOTER_KNOWLEDGE" &&
      hasClubContext &&
      (CLUB_OWNED_INTENTS.has(intent) || CLUB_OWNED_FIELDS.has(c.sourceField))
    ) {
      return false;
    }
    return true;
  });

  if (usable.length === 0) return null;

  const scored = usable
    .map((c) => ({ candidate: c, authority: LEVEL_OF[c.sourceType], stale: isStale(c, now) }))
    .sort((a, b) => {
      // Un dato caducado pierde contra uno vigente aunque sea de peor
      // fuente: más vale el dress code escrito a mano que un precio de
      // Fourvenues de hace una semana.
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      if (a.authority !== b.authority) return a.authority - b.authority;
      return (b.candidate.confidence ?? 0.5) - (a.candidate.confidence ?? 0.5);
    });

  const best = scored[0];
  if (!best) return null;

  // Un dato vivo caducado no se afirma. Es justo el caso del precio: decir
  // "son 20€" con un dato de hace días es peor que no decir nada.
  if (best.stale && best.candidate.sourceType === "FOURVENUES") return null;

  return best;
}

/**
 * ¿Por qué no se pudo responder? Se guarda en la pregunta sin respuesta para
 * que el panel pueda decir algo más útil que "la IA no supo".
 */
export type UnansweredReason = "NO_DATA" | "STALE_DATA" | "AMBIGUOUS" | "NO_LLM";

export function reasonFor(args: {
  readonly candidates: readonly Candidate[];
  readonly intent: Intent;
  readonly hasClubContext: boolean;
  readonly now: Date;
  readonly ambiguousOptions?: number;
}): UnansweredReason {
  if ((args.ambiguousOptions ?? 0) > 1) return "AMBIGUOUS";
  const relevant = args.candidates.filter((c) => !c.intent || c.intent === args.intent);
  if (relevant.length === 0) return "NO_DATA";
  if (relevant.every((c) => isStale(c, args.now))) return "STALE_DATA";
  return "NO_DATA";
}

// ── Emparejar FAQs por significado, no por letra ─────────────────────
//
// La regla de producto: una FAQ que dice «¿Puedo entrar con pantalón corto?»
// tiene que servir para «puedo ir en shorts?». Buscar la frase literal no
// vale para nada — nadie escribe la pregunta igual que la escribió el club.
//
// Lo que hace esto es lo que se puede hacer sin un modelo: sinónimos del
// dominio, solapamiento de palabras y el intent. No es semántica de verdad;
// es lo bastante bueno para las preguntas que de verdad llegan, y cuando no
// llega, el LLM tiene la FAQ en el contexto igualmente.

const SINONIMOS: readonly (readonly string[])[] = [
  ["shorts", "pantalon corto", "bermudas", "corto"],
  ["deportivas", "zapatillas", "sneakers", "tenis", "playeras"],
  ["chandal", "trackssuit", "tracksuit", "ropa deportiva"],
  ["precio", "cuesta", "vale", "cobran", "tarifa", "price", "cost"],
  ["entrada", "entradas", "ticket", "tickets", "acceso"],
  ["mesa", "mesas", "reservado", "vip", "table", "bottle"],
  ["edad", "anos", "menor", "menores", "mayor", "age", "old"],
  ["hora", "horario", "abre", "cierra", "open", "close", "time"],
  ["donde", "direccion", "ubicacion", "sitio", "where", "address"],
  ["lista", "guestlist", "guest list", "invitacion"],
  ["cumple", "cumpleanos", "birthday"],
  ["dj", "artista", "pincha", "cartel", "lineup", "line up"],
  ["comprar", "compro", "buy", "link", "enlace"],
];

/** Todas las formas equivalentes a una palabra, ella incluida. */
function expandir(palabra: string): Set<string> {
  const out = new Set<string>([palabra]);
  for (const grupo of SINONIMOS) {
    if (grupo.includes(palabra)) for (const g of grupo) out.add(g);
  }
  return out;
}

const VACIAS = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "a", "en", "y", "o",
  "que", "se", "con", "por", "para", "me", "mi", "es", "son", "hay", "si",
  "no", "puedo", "puede", "the", "a", "an", "of", "to", "in", "is", "are",
  "can", "i", "do", "does", "for",
]);

function contenido(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((w) => w.length > 1 && !VACIAS.has(w));
}

export interface FaqLike {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly keywords?: readonly string[];
  readonly intent?: string | null;
}

export interface FaqMatch {
  readonly faq: FaqLike;
  readonly score: number;
}

/**
 * Puntúa una FAQ contra una pregunta. 0 = no tiene nada que ver.
 *
 * El umbral por defecto (0.34) sale de probarlo con las frases reales que
 * puso Javier en la especificación: deja pasar «puedo ir en shorts?» contra
 * la FAQ del pantalón corto y no deja pasar «a qué hora abrís» contra ella.
 */
export function scoreFaq(pregunta: string, faq: FaqLike, intent?: Intent): number {
  const palabrasPregunta = contenido(pregunta);
  if (palabrasPregunta.length === 0) return 0;

  const universoFaq = new Set<string>();
  for (const w of contenido(faq.question)) for (const s of expandir(w)) universoFaq.add(s);
  for (const k of faq.keywords ?? []) for (const w of contenido(k)) for (const s of expandir(w)) universoFaq.add(s);
  // También el texto de la respuesta, con menos peso implícito: una FAQ que
  // dice "no se permite ropa deportiva" responde a "puedo ir en deportivas".
  const universoRespuesta = new Set<string>();
  for (const w of contenido(faq.answer)) for (const s of expandir(w)) universoRespuesta.add(s);

  let aciertos = 0;
  for (const w of palabrasPregunta) {
    const formas = expandir(w);
    let encontrado = false;
    for (const f of formas) {
      if (universoFaq.has(f)) { aciertos += 1; encontrado = true; break; }
    }
    if (encontrado) continue;
    for (const f of formas) {
      if (universoRespuesta.has(f)) { aciertos += 0.5; break; }
    }
  }

  let score = aciertos / palabrasPregunta.length;
  // Coincidir en intent es una señal fuerte: la FAQ fue etiquetada a mano
  // para eso.
  if (intent && faq.intent === intent) score += 0.35;
  return Math.min(score, 1);
}

export function matchFaqs(
  pregunta: string,
  faqs: readonly FaqLike[],
  opts: { readonly intent?: Intent; readonly threshold?: number; readonly limit?: number } = {},
): FaqMatch[] {
  const threshold = opts.threshold ?? 0.34;
  return faqs
    .map((faq) => ({ faq, score: scoreFaq(pregunta, faq, opts.intent) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}
