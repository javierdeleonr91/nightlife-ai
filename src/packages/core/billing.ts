/**
 * Planes, features y límites.
 *
 * MODELO COMERCIAL — la regla que gobierna este archivo entero:
 *
 *   CLUB       nos paga una suscripción de software
 *   PROMOTER   nos paga una suscripción de software
 *   CLIENTE    paga su entrada a Fourvenues
 *   FOURVENUES gestiona ticketing, cobro y liquidaciones
 *
 * La plataforma no toca el dinero de las entradas. No hay comisiones, payouts,
 * wallets, saldos ni revenue sharing. El promoter no es un afiliado al que
 * pagamos: es un cliente que paga por usar la herramienta, igual que el club.
 *
 * Consecuencia práctica: lo único que se factura aquí es el acceso a features.
 * Los importes son provisionales y viven en base de datos (tabla Plan); estos
 * códigos y features son el contrato que el código conoce.
 */

export type PlanAudience = "CLUB" | "PROMOTER";

export type Feature =
  | "public_link"
  | "event_selection"
  | "branding"
  | "ai_assistant"
  | "vip_module"
  | "human_handoff"
  | "whatsapp_channel"
  | "instagram_channel"
  | "follow_ups"
  | "multi_club"
  | "white_label";

export interface PlanLimits {
  /** Conversaciones con IA al mes. Es nuestro coste variable principal. */
  readonly aiConversationsPerMonth: number;
  readonly maxEvents: number;
  readonly maxClubs: number;
  readonly maxTeamMembers: number;
}

export interface PlanDefinition {
  readonly code: string;
  readonly name: string;
  readonly audience: PlanAudience;
  /** Provisional: el precio real vive en la tabla Plan y se cambia sin desplegar. */
  readonly priceCents: number;
  readonly features: readonly Feature[];
  readonly limits: PlanLimits;
}

export const PLANS: readonly PlanDefinition[] = [
  {
    code: "PROMOTER_FREE",
    name: "Promoter Free",
    audience: "PROMOTER",
    priceCents: 0,
    // Sin IA: es lo que cuesta dinero. El escaparate es gratis porque atrae
    // promoters, y el promoter que vende de verdad acaba queriendo el bot.
    features: ["public_link", "event_selection"],
    limits: { aiConversationsPerMonth: 0, maxEvents: 5, maxClubs: 1, maxTeamMembers: 1 },
  },
  {
    code: "PROMOTER_PRO",
    name: "Promoter Pro",
    audience: "PROMOTER",
    priceCents: 1500,
    features: ["public_link", "event_selection", "ai_assistant", "follow_ups", "multi_club"],
    limits: { aiConversationsPerMonth: 1000, maxEvents: 50, maxClubs: 10, maxTeamMembers: 1 },
  },
  {
    code: "CLUB_STARTER",
    name: "Club Starter",
    audience: "CLUB",
    priceCents: 4900,
    features: ["public_link", "branding", "event_selection"],
    limits: { aiConversationsPerMonth: 200, maxEvents: 20, maxClubs: 1, maxTeamMembers: 2 },
  },
  {
    code: "CLUB_PRO",
    name: "Club Pro",
    audience: "CLUB",
    priceCents: 14900,
    features: [
      "public_link", "branding", "event_selection", "ai_assistant",
      "vip_module", "human_handoff", "whatsapp_channel", "instagram_channel", "follow_ups",
    ],
    limits: { aiConversationsPerMonth: 5000, maxEvents: 200, maxClubs: 1, maxTeamMembers: 10 },
  },
  {
    code: "CLUB_PREMIUM",
    name: "Club Premium",
    audience: "CLUB",
    priceCents: 39900,
    features: [
      "public_link", "branding", "event_selection", "ai_assistant",
      "vip_module", "human_handoff", "whatsapp_channel", "instagram_channel",
      "follow_ups", "multi_club", "white_label",
    ],
    limits: { aiConversationsPerMonth: 25_000, maxEvents: 1000, maxClubs: 10, maxTeamMembers: 50 },
  },
];

export const DEFAULT_PLAN_BY_AUDIENCE: Record<PlanAudience, string> = {
  PROMOTER: "PROMOTER_FREE",
  CLUB: "CLUB_STARTER",
};

export const TRIAL_DAYS = 14;

/**
 * BETA CERRADA — el interruptor, y solo uno.
 *
 * Durante la beta cerrada no hay Stripe, no hay cobro y no hay plan que
 * comprar: todo el mundo entra invitado y con el producto entero. Un club o
 * un RRPP de la beta no tiene fila en `subscriptions`, así que
 * `getSubscriptionState` devuelve `null`, `isEntitled(null)` es `false` y
 * `hasFeature(null, "ai_assistant")` también — lo cual es correcto para el
 * modelo comercial y **equivocado** para la beta: el asistente es
 * exactamente lo que se está probando.
 *
 * Lo que NO se hace aquí, a propósito:
 *
 *  · No se toca `hasFeature`. Sigue significando lo que significa: «este
 *    plan incluye esta feature». Que devuelva `false` sin suscripción es su
 *    respuesta correcta, no un bug que tapar.
 *  · No se borra nada. `PLANS`, `getSubscriptionState`, `isEntitled`,
 *    `limitsFor` y la tabla `subscriptions` siguen enteros. Cuando la beta
 *    termine, esta constante pasa a `false` y el cobro entra sin reescribir
 *    ninguna comprobación.
 *  · No se inventa un plan `BETA` en `PLANS`. Un plan es algo que se puede
 *    contratar; esto es un periodo, y un periodo es una bandera.
 *
 * Está tipado como `boolean` y no como `true` a posta: con el tipo literal,
 * TypeScript marcaría como inalcanzable el código de cobro que tiene que
 * seguir vivo y compilando.
 */
export const BETA_CERRADA: boolean = true;

/**
 * ¿Puede responder el asistente en nombre de este dueño?
 *
 * Es la única pregunta que deben hacerse los flujos públicos. Durante la
 * beta la respuesta es sí para todos; después vuelve a ser la del plan.
 */
export function assistantAvailable(state: SubscriptionState | null): boolean {
  if (BETA_CERRADA) return true;
  return hasFeature(state, "ai_assistant");
}

export function planByCode(code: string): PlanDefinition | null {
  return PLANS.find((p) => p.code === code) ?? null;
}

export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export interface SubscriptionState {
  readonly planCode: string;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt?: Date | null;
}

/**
 * Una suscripción da acceso mientras esté en prueba o al corriente. PAST_DUE
 * sigue dando acceso a propósito: cortarle el bot a un promoter un sábado por
 * un recibo devuelto le arruina la noche y a nosotros el cliente. Se avisa y
 * se corta al pasar a CANCELED.
 */
export function isEntitled(state: SubscriptionState | null): boolean {
  if (!state) return false;
  return state.status === "TRIALING" || state.status === "ACTIVE" || state.status === "PAST_DUE";
}

export function hasFeature(state: SubscriptionState | null, feature: Feature): boolean {
  if (!isEntitled(state)) return false;
  const plan = planByCode(state!.planCode);
  return plan?.features.includes(feature) ?? false;
}

export function limitsFor(state: SubscriptionState | null): PlanLimits | null {
  if (!isEntitled(state)) return null;
  return planByCode(state!.planCode)?.limits ?? null;
}

/**
 * ¿Puede este suscriptor gastar una conversación de IA más este mes?
 * Es un límite de producto, no un cálculo de dinero: al superarlo el bot
 * degrada a plantillas, no se cobra nada extra.
 */
export function withinAiQuota(state: SubscriptionState | null, usedThisMonth: number): boolean {
  const limits = limitsFor(state);
  if (!limits) return false;
  return usedThisMonth < limits.aiConversationsPerMonth;
}
