import { DEFAULT_TTL_SECONDS, dataPoint, type DataPoint } from "@nightlife/core/provenance";
import type { AvailabilityState } from "@nightlife/ticketing/types";
import type { ConversationContext, EventContext } from "@nightlife/ai/context";
import type { Intent } from "@nightlife/ai/intents";
import type { DbClient } from "./owner";

/**
 * Capa L2: reconstruye el contexto de conversación desde la base de datos.
 *
 * Aquí es donde los datos vuelven a convertirse en DataPoints con su
 * procedencia. Es el único sitio que habla con la base de datos en nombre del
 * bot; el motor recibe el resultado y ya no consulta nada más.
 *
 * ── Por qué recibe el cliente en vez de cogerlo ──────────────────────
 * Antes usaba el `prisma` global. Con RLS activo eso es el peor fallo
 * posible: la consulta es válida, no da error y devuelve **cero filas**, así
 * que el asistente concluye que el club no tiene eventos y lo dice. Un fallo
 * silencioso que se parece a un dato.
 *
 * Ahora el cliente llega por parámetro, ya dentro de una transacción con el
 * contexto fijado. Quien llama decide cuál — y al ser obligatorio, no se
 * puede olvidar.
 *
 * El historial de la conversación tampoco se lee aquí, y es deliberado:
 * `messages` es una tabla de PROPIEDAD y el catálogo del club no lo es. Para
 * una conversación de RRPP se leen en contextos distintos, así que el
 * historial entra por `options.history`, leído por quien tiene el contexto
 * del dueño.
 *
 * Deliberadamente NO hay búsqueda vectorial: el precio vigente, la fecha y el
 * cartel son datos estructurados y se resuelven con SQL. El vector solo
 * aportaría en texto libre, y eso es Fase 2.
 */

function toDataPoint<T>(
  value: T,
  field: string,
  source: "FOURVENUES" | "MANUAL" | "CLUB_CONFIG",
  lastUpdated: Date,
  ttlSeconds: number,
  confidence: number,
): DataPoint<T> {
  return dataPoint({ value, source, confidence, field, ttlSeconds, lastUpdated });
}

export interface RetrievalOptions {
  readonly clubId: string;
  readonly eventId?: string | null;
  readonly promoterId?: string | null;
  readonly conversationId?: string | null;
  readonly partySize?: number | null;
  readonly lastIntent?: Intent | null;
  readonly priceTtlSeconds?: number;
  readonly now?: Date;
  /**
   * Últimos turnos, leídos por el llamante DENTRO del contexto del dueño.
   * No se consultan aquí: `messages` pertenece al dueño de la conversación,
   * que puede no ser el club cuyo catálogo se está leyendo.
   *
   * Se esperan del más reciente al más antiguo, tal y como los devuelve
   * `readConversationHistory`; aquí se les da la vuelta.
   */
  readonly history?: readonly {
    readonly role: string;
    readonly content: string;
    readonly intent?: string | null;
  }[];
}

export async function buildConversationContext(
  db: DbClient,
  options: RetrievalOptions,
): Promise<ConversationContext | null> {
  const now = options.now ?? new Date();
  const priceTtl = options.priceTtlSeconds ?? DEFAULT_TTL_SECONDS.currentPrice;

  const club = await db.club.findUnique({
    where: { id: options.clubId },
    include: {
      faqs: { where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 30 },
      vipOptions: { where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 20 },
    },
  });
  if (!club || club.status !== "ACTIVE") return null;

  // Eventos próximos: la ventana empieza 6 horas atrás porque una fiesta que
  // empezó a las 00:00 sigue siendo "esta noche" a las 03:00.
  const upcoming = await db.event.findMany({
    where: {
      clubId: club.id,
      startsAt: { gte: new Date(now.getTime() - 6 * 3600 * 1000) },
      status: { in: ["ACTIVE", "SOLD_OUT"] },
      ...(options.promoterId
        ? { promoterEvents: { some: { promoterId: options.promoterId } } }
        : {}),
    },
    orderBy: { startsAt: "asc" },
    take: 10,
    include: {
      source: true,
      ticketTypes: { orderBy: { sortOrder: "asc" }, include: { prices: true } },
    },
  });

  // El evento en foco: el que ya se estaba hablando, o el más próximo.
  const focus =
    (options.eventId ? upcoming.find((e) => e.id === options.eventId) : undefined) ?? upcoming[0] ?? null;

  let event: EventContext | null = null;
  if (focus) {
    const syncedAt = focus.source?.lastSyncedAt ?? focus.updatedAt;
    const fromManual = focus.source?.provider === "manual";
    const source = fromManual ? ("MANUAL" as const) : ("FOURVENUES" as const);
    const confidence = fromManual ? 1 : 0.9;

    const currentPrices = focus.ticketTypes
      .map((t) => ({
        type: t,
        price: t.prices.find((p) => p.isCurrent) ?? null,
      }))
      .filter((x) => x.price !== null);

    const availableNow = currentPrices.filter((x) => x.type.status === "AVAILABLE");
    const sorted = [...availableNow].sort(
      (a, b) => (a.price?.amountCents ?? 0) - (b.price?.amountCents ?? 0),
    );
    const currentCents = sorted[0]?.price?.amountCents ?? null;
    const nextCents =
      currentCents === null
        ? null
        : (currentPrices
            .map((x) => x.price?.amountCents ?? 0)
            .filter((c) => c > currentCents)
            .sort((a, b) => a - b)[0] ?? null);

    const allSoldOut =
      currentPrices.length > 0 && currentPrices.every((x) => x.type.status === "SOLD_OUT");
    const availabilityState: AvailabilityState =
      availableNow.length > 0 ? "AVAILABLE" : allSoldOut ? "SOLD_OUT" : "UNKNOWN";

    // Precios históricos: los que ya no están vigentes. Permiten responder
    // "¿cuánto costaba?" sin inventar nada.
    const historical = focus.ticketTypes
      .flatMap((t) => t.prices.filter((p) => !p.isCurrent).map((p) => p.amountCents))
      .sort((a, b) => a - b);

    event = {
      id: focus.id,
      name: toDataPoint(focus.name, "eventName", source, syncedAt, DEFAULT_TTL_SECONDS.eventName, confidence),
      startsAt: toDataPoint(
        focus.startsAt.toISOString(),
        "startsAt",
        source,
        syncedAt,
        DEFAULT_TTL_SECONDS.startsAt,
        confidence,
      ),
      djs:
        focus.djLineup.length > 0
          ? toDataPoint(focus.djLineup, "dj", source, syncedAt, DEFAULT_TTL_SECONDS.dj, confidence)
          : null,
      currentPrice:
        currentCents === null
          ? null
          : toDataPoint(currentCents, "currentPrice", source, syncedAt, priceTtl, confidence),
      nextPrice:
        nextCents === null
          ? null
          : toDataPoint(nextCents, "nextPrice", source, syncedAt, priceTtl, confidence),
      availability: toDataPoint(
        availabilityState,
        "availability",
        source,
        syncedAt,
        DEFAULT_TTL_SECONDS.availability,
        // La fuente pública no sabe de disponibilidad real: confianza 0
        // cuando es UNKNOWN, para que nunca se afirme.
        availabilityState === "UNKNOWN" ? 0 : confidence,
      ),
      ticketUrl: focus.ticketUrl
        ? toDataPoint(focus.ticketUrl, "ticketUrl", source, syncedAt, DEFAULT_TTL_SECONDS.ticketUrl, confidence)
        : null,
      historicalPricesCents: historical,
      status: focus.status as EventContext["status"],
    };
  }

  const promoter = options.promoterId
    ? await db.promoter.findUnique({ where: { id: options.promoterId } })
    : null;

  const history = options.history ?? [];

  return {
    club: {
      id: club.id,
      name: club.name,
      city: club.city,
      timezone: club.timezone,
      address: club.address,
      minAge: club.minAge,
      dressCode: club.dressCode,
      openingHours: club.openingHours,
      policies: club.policies,
      whatsapp: club.whatsapp,
      instagram: club.instagram,
    },
    event,
    upcomingEvents: upcoming.map((e) => ({
      id: e.id,
      name: e.name,
      startsAtIso: e.startsAt.toISOString(),
    })),
    // El VIP se filtra por número de personas: ofrecer una mesa de 4 a un
    // grupo de 12 es peor que no ofrecer nada.
    vipOptions: club.vipOptions
      .filter((v) =>
        options.partySize ? v.minPax <= options.partySize && v.maxPax >= options.partySize : true,
      )
      .map((v) => ({
        id: v.id,
        name: v.name,
        priceCents: v.priceCents,
        minPax: v.minPax,
        maxPax: v.maxPax,
        includes: v.includes,
        bookingContact: v.bookingContact,
      })),
    faqs: club.faqs.map((f) => ({
      id: f.id,
      question: f.question,
      answer: f.answer,
      keywords: f.keywords,
    })),
    // Copia antes de invertir: `history` llega readonly y `reverse()` muta.
    history: [...history]
      .reverse()
      .map((m) => ({
        role: m.role === "CUSTOMER" ? ("CUSTOMER" as const) : ("ASSISTANT" as const),
        content: m.content,
        intent: ((m.intent ?? null) as Intent | null),
      })),
    promoter: promoter
      ? { id: promoter.id, displayName: promoter.displayName }
      : null,
    partySize: options.partySize ?? null,
    lastIntent: options.lastIntent ?? null,
    locale: "es",
    now,
  };
}
