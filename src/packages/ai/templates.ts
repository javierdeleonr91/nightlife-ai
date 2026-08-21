/**
 * Respuestas deterministas (capa L3).
 *
 * Las preguntas más frecuentes del sector tienen una respuesta correcta y
 * corta. Generarlas con plantilla en lugar de con un modelo tiene tres
 * ventajas que se acumulan justo el viernes por la noche: coste cero,
 * latencia de milisegundos y cero posibilidad de inventar.
 *
 * Tono: como responde alguien que trabaja en la puerta y conoce el sitio.
 * Frases cortas, sin "estimado usuario", sin párrafos, un emoji como mucho.
 */

import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import type { ConversationContext } from "./context";
import type { FactSet } from "./factset";
import type { Intent } from "./intents";

export interface Cta {
  readonly label: string;
  readonly url: string;
  readonly kind: "BUY" | "VIP" | "WHATSAPP";
}

export interface TemplateAnswer {
  readonly text: string;
  readonly cta: Cta | null;
  readonly usedSources: readonly string[];
}

const fmt = (cents: number) => formatMoney(money(cents));

function buyCta(ctx: ConversationContext, facts: FactSet): Cta | null {
  const url = ctx.event?.ticketUrl?.value;
  if (!url || !facts.urls.includes(url)) return null;
  return { label: "COMPRAR ENTRADA", url, kind: "BUY" };
}

/**
 * Lo que se responde cuando no podemos confirmar el precio. Es preferible a
 * inventar y, comercialmente, sigue empujando al checkout.
 */
function priceUnavailable(ctx: ConversationContext, facts: FactSet): TemplateAnswer {
  const cta = buyCta(ctx, facts);
  return {
    text: cta
      ? "No puedo confirmarte el precio de ahora mismo. Aquí lo tienes actualizado 👇"
      : "No puedo confirmarte el precio ahora mismo. Te paso con el equipo y te lo dicen al momento.",
    cta,
    usedSources: [],
  };
}

/**
 * Devuelve null cuando el intent necesita lenguaje de verdad y hay que subir
 * al LLM. Esa frontera es a propósito: la plantilla solo cubre lo que puede
 * cubrir bien.
 */
export function tryTemplate(
  intent: Intent,
  ctx: ConversationContext,
  facts: FactSet,
): TemplateAnswer | null {
  const club = ctx.club;
  const event = ctx.event;

  switch (intent) {
    case "TICKET_PRICE": {
      const price = event?.currentPrice;
      if (!price || !facts.amountsCents.includes(price.value)) return priceUnavailable(ctx, facts);

      let text = `Ahora mismo está a ${fmt(price.value)} 🔥`;
      const next = event?.nextPrice;
      if (next && facts.amountsCents.includes(next.value) && next.value > price.value) {
        text += ` Después sube a ${fmt(next.value)}.`;
      }
      return { text, cta: buyCta(ctx, facts), usedSources: ["FOURVENUES"] };
    }

    case "PRICE_FUTURE": {
      const next = event?.nextPrice;
      if (next && facts.amountsCents.includes(next.value)) {
        return {
          text: `El siguiente release está a ${fmt(next.value)}. No sé cuándo salta exactamente, así que si te interesa mejor ahora.`,
          cta: buyCta(ctx, facts),
          usedSources: ["FOURVENUES"],
        };
      }
      return {
        text: "No sé qué precio tendrá más adelante. Lo que sí te puedo decir es el de ahora mismo 👇",
        cta: buyCta(ctx, facts),
        usedSources: [],
      };
    }

    case "PRICE_HISTORY": {
      const history = event?.historicalPricesCents ?? [];
      if (history.length === 0) return null;
      const cheapest = Math.min(...history);
      return {
        text: `El primer release estuvo a ${fmt(cheapest)}, pero ya se agotó.`,
        cta: buyCta(ctx, facts),
        usedSources: ["FOURVENUES"],
      };
    }

    case "TICKET_AVAILABILITY": {
      const state = facts.claims.availability;
      if (state === "SOLD_OUT") {
        return { text: "Está agotado por la web.", cta: null, usedSources: ["FOURVENUES"] };
      }
      // Aunque la fuente diga AVAILABLE, nunca decimos cuántas quedan.
      return {
        text:
          state === "AVAILABLE"
            ? "Sí, todavía se pueden comprar. Aquí las tienes 👇"
            : "No te puedo confirmar cuántas quedan, pero aquí lo ves en tiempo real 👇",
        cta: buyCta(ctx, facts),
        usedSources: state === "AVAILABLE" ? ["FOURVENUES"] : [],
      };
    }

    case "BUY_TICKET": {
      const cta = buyCta(ctx, facts);
      if (!cta) return null;
      const price = event?.currentPrice;
      const text =
        price && facts.amountsCents.includes(price.value)
          ? `Va 🔥 ${fmt(price.value)} ahora mismo:`
          : "Aquí lo tienes 👇";
      return { text, cta, usedSources: price ? ["FOURVENUES"] : [] };
    }

    case "LOCATION": {
      if (!club.address) return null;
      return {
        text: `Estamos en ${club.address}, ${club.city}.`,
        cta: null,
        usedSources: ["CLUB_CONFIG"],
      };
    }

    case "OPENING_TIME": {
      if (!club.openingHours) return null;
      return { text: club.openingHours, cta: null, usedSources: ["CLUB_CONFIG"] };
    }

    case "AGE_REQUIREMENT": {
      if (typeof club.minAge !== "number") return null;
      return {
        text: `Mínimo ${club.minAge} años, con DNI o pasaporte.`,
        cta: null,
        usedSources: ["CLUB_CONFIG"],
      };
    }

    case "DRESS_CODE": {
      if (!club.dressCode) return null;
      return { text: club.dressCode, cta: null, usedSources: ["CLUB_CONFIG"] };
    }

    case "EVENT_DATE": {
      if (!event?.startsAt) return null;
      const date = new Date(event.startsAt.value);
      if (Number.isNaN(date.getTime())) return null;
      return {
        text: `${event.name.value} es el ${nightWeekdayEs(date, club.timezone)}, ${formatEventWhen(date, club.timezone)}.`,
        cta: buyCta(ctx, facts),
        usedSources: ["FOURVENUES"],
      };
    }

    case "EVENT_TIME": {
      if (!event?.startsAt) return null;
      const date = new Date(event.startsAt.value);
      if (Number.isNaN(date.getTime())) return null;
      const time = new Intl.DateTimeFormat("es-ES", {
        timeZone: club.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
      return { text: `Empieza a las ${time}.`, cta: buyCta(ctx, facts), usedSources: ["FOURVENUES"] };
    }

    case "DJ_INFO": {
      const djs = event?.djs;
      if (!djs || !facts.claims.hasKnownDjs || djs.value.length === 0) {
        return {
          text: "Todavía no tengo el cartel confirmado. En cuanto lo tengamos se publica.",
          cta: null,
          usedSources: [],
        };
      }
      const list = djs.value.join(" y ");
      return { text: `Pincha ${list}.`, cta: buyCta(ctx, facts), usedSources: ["FOURVENUES"] };
    }

    case "IS_BOT": {
      // Se dice la verdad. Lo exige el art. 50 del Reglamento de IA de la UE
      // y, además, quien pregunta esto suele querer hablar con alguien:
      // negarlo pierde justo la conversación con más intención.
      return {
        text: `Soy el asistente de ${club.name}, respondo automáticamente. ¿Quieres que te pase con el equipo?`,
        cta: null,
        usedSources: [],
      };
    }

    case "HUMAN_AGENT": {
      return { text: "Claro. Te paso con el equipo 👌", cta: null, usedSources: [] };
    }

    case "GREETING": {
      const price = event?.currentPrice;
      if (event && price && facts.amountsCents.includes(price.value)) {
        return {
          text: `¡Hola! Este finde tenemos ${event.name.value}, ahora mismo a ${fmt(price.value)}. ¿Te cuento algo?`,
          cta: buyCta(ctx, facts),
          usedSources: ["FOURVENUES"],
        };
      }
      return { text: `¡Hola! ¿En qué te ayudo?`, cta: null, usedSources: [] };
    }

    default:
      return null;
  }
}

/** FAQ por coincidencia de palabras clave, antes de tocar el LLM. */
export function matchFaq(message: string, ctx: ConversationContext): TemplateAnswer | null {
  const text = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  let best: { faq: ConversationContext["faqs"][number]; score: number } | null = null;
  for (const faq of ctx.faqs) {
    let score = 0;
    for (const keyword of faq.keywords) {
      const k = keyword.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (k.length > 2 && text.includes(k)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) best = { faq, score };
  }

  if (!best || best.score < 2) return null;
  return { text: best.faq.answer, cta: null, usedSources: ["FAQ"] };
}

/** Respuesta cuando falla todo lo demás. Nunca deja al cliente sin salida. */
export function safeFallback(ctx: ConversationContext, facts: FactSet): TemplateAnswer {
  const cta = buyCta(ctx, facts);
  if (cta) {
    return { text: "No te lo puedo confirmar yo. Aquí tienes la info actualizada 👇", cta, usedSources: [] };
  }
  return { text: "Eso mejor te lo confirma el equipo. Te paso con ellos 👌", cta: null, usedSources: [] };
}
