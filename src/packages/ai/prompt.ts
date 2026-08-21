/**
 * Construcción del prompt.
 *
 * Nunca se manda el catálogo del club: solo el evento en foco y los hechos
 * autorizados. Menos contexto es más barato, más rápido y menos superficie
 * para que el modelo se invente cosas.
 */

import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen } from "@nightlife/core/time";
import type { ConversationContext } from "./context";
import { factSetToPromptBlock, type FactSet } from "./factset";

export const SYSTEM_RULES = `Eres el asistente de venta de un club nocturno. Respondes a clientes por chat.

CÓMO HABLAS
- Frases cortas. Una o dos como máximo.
- Cercano y directo, como alguien que trabaja en el club y lo conoce.
- Nunca "estimado usuario", nunca párrafos, nunca lenguaje corporativo.
- Un emoji como mucho, y solo si encaja.
- No insistas ni presiones. Si preguntan información, das información.

QUÉ PUEDES DECIR
- Solo lo que aparezca en DATOS AUTORIZADOS. Nada más.
- No inventes precios, disponibilidad, eventos, DJs, políticas ni opciones VIP.
- Nunca digas cuántas entradas quedan: no lo sabemos.
- Si falta un dato, dilo con naturalidad y ofrece el enlace de compra.
- Si te preguntan si eres un bot, dilo y ofrece pasar con el equipo.

CUANDO QUIEREN COMPRAR
- No expliques de más. Precio actual y enlace.`;

export function buildSystemPrompt(ctx: ConversationContext, facts: FactSet): string {
  const parts: string[] = [SYSTEM_RULES, ""];

  parts.push("CLUB");
  parts.push(`- Nombre: ${ctx.club.name} (${ctx.club.city})`);
  if (ctx.club.address) parts.push(`- Dirección: ${ctx.club.address}`);
  if (typeof ctx.club.minAge === "number") parts.push(`- Edad mínima: ${ctx.club.minAge}`);
  if (ctx.club.dressCode) parts.push(`- Dress code: ${ctx.club.dressCode}`);
  if (ctx.club.openingHours) parts.push(`- Horario: ${ctx.club.openingHours}`);

  if (ctx.promoter) {
    parts.push("", `Hablas en nombre de ${ctx.promoter.displayName}, que vende entradas para este club.`);
  }

  if (ctx.event) {
    parts.push("", "EVENTO EN FOCO");
    parts.push(`- ${ctx.event.name.value}`);
    if (ctx.event.startsAt) {
      const date = new Date(ctx.event.startsAt.value);
      if (!Number.isNaN(date.getTime())) {
        parts.push(`- Cuándo: ${formatEventWhen(date, ctx.club.timezone)}`);
      }
    }
  }

  if (ctx.vipOptions.length > 0) {
    parts.push("", "OPCIONES VIP");
    for (const vip of ctx.vipOptions) {
      const price = vip.priceCents !== null ? formatMoney(money(vip.priceCents)) : "precio a consultar";
      parts.push(`- ${vip.name}: ${price}, de ${vip.minPax} a ${vip.maxPax} personas`);
    }
    parts.push("No afirmes que hay disponibilidad: ofrece contactar con el equipo para confirmarla.");
  }

  parts.push("", "DATOS AUTORIZADOS");
  parts.push(factSetToPromptBlock(facts, (cents) => formatMoney(money(cents))));

  if (ctx.upcomingEvents.length > 1) {
    parts.push("", "OTROS EVENTOS PRÓXIMOS (solo para desambiguar, sin precios)");
    for (const e of ctx.upcomingEvents.slice(0, 5)) {
      parts.push(`- ${e.name}`);
    }
  }

  return parts.join("\n");
}

/**
 * El texto del cliente va delimitado. No es la defensa principal contra
 * prompt injection —esa es el validador— pero quita el caso fácil.
 */
export function buildMessages(
  ctx: ConversationContext,
  userMessage: string,
): { role: "user" | "assistant"; content: string }[] {
  const history = ctx.history.slice(-6).map((turn) => ({
    role: turn.role === "CUSTOMER" ? ("user" as const) : ("assistant" as const),
    content: turn.content,
  }));
  return [...history, { role: "user" as const, content: userMessage }];
}
