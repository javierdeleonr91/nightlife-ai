/**
 * El motor de conversación.
 *
 * Orquesta el embudo de seis capas. Cada capa intenta resolver sin el modelo;
 * el LLM es la última y la más cara. Toda salida —venga de donde venga—
 * pasa por el validador antes de existir.
 */

import type { ConversationContext } from "./context";
import { buildFactSet, type FactSet } from "./factset";
import { PURCHASE_INTENTS, refineWithContext, routeIntent, type Intent } from "./intents";
import type { LlmProvider } from "./llm";
import { buildMessages, buildSystemPrompt } from "./prompt";
import { matchFaq, safeFallback, tryTemplate, type Cta } from "./templates";
import { validateResponse, violationsToFeedback, type Violation } from "./validator";

export type ResolvedBy = "ROUTER" | "FAQ" | "TEMPLATE" | "LLM" | "FALLBACK" | "HANDOFF";

export interface EngineResult {
  readonly text: string;
  readonly cta: Cta | null;
  readonly intent: Intent;
  readonly resolvedBy: ResolvedBy;
  readonly purchaseIntent: boolean;
  readonly requestsHandoff: boolean;
  readonly facts: FactSet;
  readonly violations: readonly Violation[];
  readonly llmAttempts: number;
  readonly model: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly eventFocusId: string | null;
  readonly partySize: number | null;
}

export interface EngineOptions {
  readonly llm?: LlmProvider | null;
  /** Presupuesto agotado: se degrada a plantillas en lugar de dejar de responder. */
  readonly llmDisabled?: boolean;
  readonly maxLlmAttempts?: number;
  readonly now?: () => number;
}

export async function runEngine(
  userMessage: string,
  ctx: ConversationContext,
  options: EngineOptions = {},
): Promise<EngineResult> {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  const maxAttempts = options.maxLlmAttempts ?? 2;

  // ── L0: router determinista ─────────────────────────────────────────
  const routed = refineWithContext(
    routeIntent(userMessage),
    { lastIntent: ctx.lastIntent, partySize: ctx.partySize },
    userMessage,
  );
  const intent = routed.intent;

  // ── L2: hechos autorizados ──────────────────────────────────────────
  const facts = buildFactSet({
    now: ctx.now,
    currentPrice: ctx.event?.currentPrice ?? null,
    nextPrice: ctx.event?.nextPrice ?? null,
    historicalPricesCents: ctx.event?.historicalPricesCents ?? [],
    availability: ctx.event?.availability ?? null,
    eventName: ctx.event?.name ?? null,
    startsAt: ctx.event?.startsAt ?? null,
    djs: ctx.event?.djs ?? null,
    ticketUrl: ctx.event?.ticketUrl ?? null,
    minAge: ctx.club.minAge ?? null,
    dressCode: ctx.club.dressCode ?? null,
    vipOptions: ctx.vipOptions.map((v) => ({
      name: v.name,
      priceCents: v.priceCents,
      minPax: v.minPax,
      maxPax: v.maxPax,
    })),
  });

  const base = {
    intent,
    facts,
    purchaseIntent: PURCHASE_INTENTS.has(intent),
    eventFocusId: ctx.event?.id ?? null,
    partySize: ctx.partySize,
  };

  const finish = (
    partial: Pick<EngineResult, "text" | "cta" | "resolvedBy"> &
      Partial<Pick<EngineResult, "violations" | "llmAttempts" | "model" | "tokensIn" | "tokensOut" | "requestsHandoff">>,
  ): EngineResult => ({
    ...base,
    text: partial.text,
    cta: partial.cta,
    resolvedBy: partial.resolvedBy,
    requestsHandoff: partial.requestsHandoff ?? intent === "HUMAN_AGENT",
    violations: partial.violations ?? [],
    llmAttempts: partial.llmAttempts ?? 0,
    model: partial.model ?? null,
    tokensIn: partial.tokensIn ?? 0,
    tokensOut: partial.tokensOut ?? 0,
    latencyMs: clock() - startedAt,
  });

  // Petición explícita de humano: no se discute ni se intenta retener.
  if (intent === "HUMAN_AGENT") {
    return finish({
      text: "Claro. Te paso con el equipo 👌",
      cta: null,
      resolvedBy: "HANDOFF",
      requestsHandoff: true,
    });
  }

  // ── L3: plantilla determinista ──────────────────────────────────────
  const template = tryTemplate(intent, ctx, facts);
  if (template) {
    const check = validateResponse(template.text, facts);
    // Una plantilla que no valida es un bug nuestro, no del modelo: se cae al
    // fallback seguro y queda registrado para arreglarlo.
    if (check.ok) {
      return finish({ text: template.text, cta: template.cta, resolvedBy: "TEMPLATE" });
    }
    const safe = safeFallback(ctx, facts);
    return finish({
      text: safe.text,
      cta: safe.cta,
      resolvedBy: "FALLBACK",
      violations: check.violations,
    });
  }

  // ── FAQ por palabras clave ──────────────────────────────────────────
  const faq = matchFaq(userMessage, ctx);
  if (faq) {
    const check = validateResponse(faq.text, facts);
    if (check.ok) return finish({ text: faq.text, cta: faq.cta, resolvedBy: "FAQ" });
  }

  // ── L4/L5: modelo con validación ────────────────────────────────────
  if (!options.llm || options.llmDisabled) {
    const safe = safeFallback(ctx, facts);
    return finish({ text: safe.text, cta: safe.cta, resolvedBy: "FALLBACK" });
  }

  const system = buildSystemPrompt(ctx, facts);
  const messages = buildMessages(ctx, userMessage);
  let attempts = 0;
  let lastViolations: readonly Violation[] = [];
  let model: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    let generated: string;
    try {
      const response = await options.llm.complete({
        system:
          attempts === 1
            ? system
            : `${system}\n\n${violationsToFeedback(lastViolations)}`,
        messages,
        maxTokens: 250,
        temperature: 0.4,
      });
      generated = response.text;
      model = response.model;
      tokensIn += response.tokensIn;
      tokensOut += response.tokensOut;
    } catch {
      break; // el modelo no responde: fallback, nunca silencio
    }

    const check = validateResponse(generated, facts);
    if (check.ok) {
      const cta = PURCHASE_INTENTS.has(intent) ? (tryTemplate("BUY_TICKET", ctx, facts)?.cta ?? null) : null;
      return finish({
        text: generated,
        cta,
        resolvedBy: "LLM",
        llmAttempts: attempts,
        model,
        tokensIn,
        tokensOut,
      });
    }
    lastViolations = check.violations;
  }

  // Dos intentos rechazados: mejor callar que arriesgar un dato falso.
  const safe = safeFallback(ctx, facts);
  return finish({
    text: safe.text,
    cta: safe.cta,
    resolvedBy: "FALLBACK",
    violations: lastViolations,
    llmAttempts: attempts,
    model,
    tokensIn,
    tokensOut,
  });
}
