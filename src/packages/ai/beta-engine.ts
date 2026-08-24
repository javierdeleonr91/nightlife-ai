import type { Intent } from "./intents";
import { routeIntent, refineWithContext, extractPartySize, PURCHASE_INTENTS } from "./intents";
import { detectLanguage, type Lang } from "./language";
import {
  resolveAnswer,
  matchFaqs,
  reasonFor,
  type Candidate,
  type FaqLike,
  type ResolvedAnswer,
  type UnansweredReason,
} from "./knowledge";

/**
 * La decisión del asistente, sin efectos secundarios.
 *
 * Esta función no habla con la base de datos, no llama al LLM y no escribe
 * nada. Recibe el mensaje, lo que ya se sabe de la conversación y los datos
 * cargados, y devuelve **qué hay que hacer**. Quien la llama se encarga de
 * hacerlo.
 *
 * Está separada así por una razón práctica: es donde viven las reglas que no
 * se pueden romper —no inventar, no dejar que un RRPP hable por un club, no
 * responder cuando la IA está callada— y separada se puede probar entera en
 * milisegundos, sin levantar Postgres ni gastar un token.
 */

export type Decision =
  /** Hay dato con fuente: se responde. */
  | {
      readonly kind: "ANSWER";
      readonly intent: Intent;
      readonly lang: Lang;
      readonly resolved: ResolvedAnswer;
      readonly partySize: number | null;
      readonly showBuyCta: boolean;
    }
  /** Falta un detalle mínimo para poder responder. Se pregunta SOLO eso. */
  | {
      readonly kind: "CLARIFY";
      readonly intent: Intent;
      readonly lang: Lang;
      readonly options: readonly string[];
      readonly field: "event" | "club";
    }
  /** No hay información. NO se inventa: se guarda para que un humano la conteste. */
  | {
      readonly kind: "UNANSWERED";
      readonly intent: Intent;
      readonly lang: Lang;
      readonly reason: UnansweredReason;
    }
  /** El cliente ha pedido una persona, o la IA se ha quedado sin salida. */
  | {
      readonly kind: "HANDOFF";
      readonly intent: Intent;
      readonly lang: Lang;
      readonly reason: "REQUESTED" | "NEEDS_HUMAN";
    }
  /** Un humano ya está en la conversación: la IA se calla. */
  | { readonly kind: "SILENT"; readonly reason: "HUMAN_ACTIVE" | "AUTOREPLY_OFF" | "CLOSED" };

export interface ConversationState {
  readonly status: "AI_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED";
  readonly lastIntent?: Intent | null;
  readonly partySize?: number | null;
  readonly locale?: Lang | null;
  /** De qué club se está hablando. NO es de quién es la conversación. */
  readonly contextClubId?: string | null;
  readonly eventFocusId?: string | null;
}

export interface DecisionInput {
  readonly message: string;
  readonly state: ConversationState;
  /** false = el dueño ha apagado la respuesta automática de ese canal. */
  readonly autoReply: boolean;
  /** Datos con procedencia ya cargados por quien llama. */
  readonly candidates: readonly Candidate[];
  /** FAQs del club y del RRPP, ya filtradas por dueño. */
  readonly faqs: readonly FaqLike[];
  /** Eventos entre los que habría que elegir, si son varios. */
  readonly eventOptions?: readonly { readonly id: string; readonly label: string }[];
  /** Clubs entre los que habría que elegir. */
  readonly clubOptions?: readonly { readonly id: string; readonly label: string }[];
  /** false cuando no hay clave de LLM: no se finge un asistente. */
  readonly llmAvailable: boolean;
  readonly now: Date;
}

/**
 * Intents que no necesitan ningún dato externo: se responden con una
 * plantilla y nunca generan una pregunta sin respuesta.
 */
const SIN_DATOS: ReadonlySet<Intent> = new Set<Intent>(["GREETING", "IS_BOT"]);

/** Intents que necesitan saber de qué evento se habla para tener sentido. */
const NECESITA_EVENTO: ReadonlySet<Intent> = new Set<Intent>([
  "TICKET_PRICE",
  "TICKET_AVAILABILITY",
  "EVENT_DATE",
  "EVENT_TIME",
  "DJ_INFO",
  "BUY_TICKET",
]);

export function decide(input: DecisionInput): Decision {
  const { message, state, candidates, faqs, now } = input;

  // ── 1. ¿Debe la IA hablar siquiera? ────────────────────────────────
  // Va primero y no se discute. Si un humano cogió la conversación, la IA
  // interrumpiéndole es peor que no responder: el cliente ve dos voces.
  if (state.status === "HUMAN_ACTIVE") return { kind: "SILENT", reason: "HUMAN_ACTIVE" };
  if (state.status === "CLOSED") return { kind: "SILENT", reason: "CLOSED" };
  if (!input.autoReply) return { kind: "SILENT", reason: "AUTOREPLY_OFF" };

  const lang = detectLanguage(message, state.locale ?? null).lang;
  const bruto = routeIntent(message);
  const route = refineWithContext(
    bruto,
    { lastIntent: state.lastIntent ?? null, partySize: state.partySize ?? null },
    message,
  );
  const intent = route.intent;
  const partySize = extractPartySize(message) ?? state.partySize ?? null;

  // ── 2. Pedir una persona siempre gana ──────────────────────────────
  if (intent === "HUMAN_AGENT") {
    return { kind: "HANDOFF", intent, lang, reason: "REQUESTED" };
  }

  // ── 3. Saludos y «¿eres un bot?»: no necesitan datos ───────────────
  if (SIN_DATOS.has(intent)) {
    return {
      kind: "ANSWER",
      intent,
      lang,
      partySize,
      showBuyCta: false,
      resolved: {
        candidate: {
          sourceType: "CONVERSATION",
          sourceId: "template",
          sourceField: intent.toLowerCase(),
          text: "",
        },
        authority: 5,
        stale: false,
      },
    };
  }

  // ── 4. Sin asistente configurado no se finge uno ───────────────────
  // Se guarda igual como pregunta sin respuesta: cuando llegue la clave,
  // el dueño ya sabe qué le estaban preguntando.
  if (!input.llmAvailable && candidates.length === 0 && faqs.length === 0) {
    return { kind: "UNANSWERED", intent, lang, reason: "NO_LLM" };
  }

  const hasClubContext = Boolean(state.contextClubId);

  // ── 5. Ambigüedad: preguntar SOLO lo mínimo ────────────────────────
  // Con un solo evento se responde directamente. Con tres y ninguno
  // elegido, se pregunta cuál — nunca se elige uno al azar.
  if (NECESITA_EVENTO.has(intent) && !state.eventFocusId) {
    const eventos = input.eventOptions ?? [];
    if (eventos.length > 1) {
      return { kind: "CLARIFY", intent, lang, field: "event", options: eventos.map((e) => e.label) };
    }
    const clubs = input.clubOptions ?? [];
    if (eventos.length === 0 && clubs.length > 1 && !hasClubContext) {
      return { kind: "CLARIFY", intent, lang, field: "club", options: clubs.map((c) => c.label) };
    }
  }

  // ── 6. Las FAQs entran como candidatos, emparejadas por significado ─
  const faqMatches = matchFaqs(message, faqs, { intent });
  const conFaqs: Candidate[] = [
    ...candidates,
    ...faqMatches.map((m) => ({
      // Una FAQ del club es conocimiento del club; una del RRPP, del RRPP.
      // Quien llama etiqueta el id con el prefijo para que se distingan.
      sourceType: m.faq.id.startsWith("promoter:")
        ? ("PROMOTER_KNOWLEDGE" as const)
        : ("CLUB_KNOWLEDGE" as const),
      sourceId: m.faq.id,
      sourceField: `faq:${m.faq.id}`,
      text: m.faq.answer,
      lastUpdated: null,
      ttlSeconds: null,
      confidence: m.score,
      intent: (m.faq.intent as Intent | undefined) ?? null,
    })),
  ];

  // ── 7. ¿Hay algo que se pueda afirmar? ─────────────────────────────
  const resolved = resolveAnswer({ candidates: conFaqs, intent, hasClubContext, now });

  if (!resolved) {
    // Aquí está la regla central de la beta: no se inventa nada. Si el
    // cliente pidió algo que solo una persona puede resolver, se pasa a un
    // humano; si no, se guarda la pregunta para que el dueño la conteste y
    // la próxima vez sí se sepa.
    if (intent === "TABLE_RESERVATION" || intent === "VIP" || intent === "BIRTHDAY") {
      return { kind: "HANDOFF", intent, lang, reason: "NEEDS_HUMAN" };
    }
    return {
      kind: "UNANSWERED",
      intent,
      lang,
      reason: reasonFor({
        candidates: conFaqs,
        intent,
        hasClubContext,
        now,
        ambiguousOptions: input.eventOptions?.length ?? 0,
      }),
    };
  }

  return {
    kind: "ANSWER",
    intent,
    lang,
    resolved,
    partySize,
    showBuyCta: PURCHASE_INTENTS.has(intent),
  };
}

/**
 * Actualización de contexto que corresponde a este turno.
 *
 * El dueño NUNCA está aquí: es inmutable y lo garantiza la base de datos.
 * `contextClubId` sí cambia — es de lo que se habla, y la conversación puede
 * pasar de MON a Liberata sin dejar de ser del mismo RRPP.
 */
export interface ContextUpdate {
  readonly lastIntent?: Intent;
  readonly partySize?: number;
  readonly locale?: Lang;
  readonly contextClubId?: string | null;
  readonly eventFocusId?: string | null;
  readonly purchaseIntent?: boolean;
}

/**
 * Resuelve una referencia como «la de MON» contra los clubs de los que se
 * acaba de hablar. Es lo que hace que el cliente no tenga que repetirse.
 */
export function resolveClubReference(
  message: string,
  options: readonly { readonly id: string; readonly label: string }[],
): string | null {
  const texto = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  let mejor: { id: string; len: number } | null = null;
  for (const o of options) {
    const etiqueta = o.label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (etiqueta.length >= 3 && texto.includes(etiqueta)) {
      // El nombre más largo que encaje: "mon madrid" gana a "mon".
      if (!mejor || etiqueta.length > mejor.len) mejor = { id: o.id, len: etiqueta.length };
    }
  }
  return mejor?.id ?? null;
}

export function contextUpdateFor(args: {
  readonly decision: Decision;
  readonly message: string;
  readonly clubOptions?: readonly { readonly id: string; readonly label: string }[];
}): ContextUpdate {
  const { decision, message } = args;
  if (decision.kind === "SILENT") return {};

  const update: {
    lastIntent?: Intent;
    partySize?: number;
    locale?: Lang;
    contextClubId?: string | null;
    purchaseIntent?: boolean;
  } = { lastIntent: decision.intent, locale: decision.lang };

  const size = extractPartySize(message);
  if (size !== null) update.partySize = size;

  const club = resolveClubReference(message, args.clubOptions ?? []);
  if (club) update.contextClubId = club;

  if (PURCHASE_INTENTS.has(decision.intent)) update.purchaseIntent = true;

  return update;
}
