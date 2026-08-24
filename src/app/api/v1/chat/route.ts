import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { runEngine } from "@nightlife/ai/engine";
import { extractPartySize, type Intent } from "@nightlife/ai/intents";
import { AnthropicProvider } from "@nightlife/ai/llm";
import { assistantAvailable } from "@nightlife/core/billing";
import {
  buildConversationContext,
  getSubscriptionState,
  unsafePrismaForMigrationsOnly as prisma,
} from "@nightlife/db";
import { withPublicClubRls } from "@nightlife/db/owner";
import {
  openWebchatSession,
  persistWebchatTurn,
  readConversationHistory,
  recordIncomingMessage,
  resolveWebchatOwner,
} from "@nightlife/db/webchat";
import { hashCustomerHandle, signChatToken, verifyChatToken } from "@nightlife/auth";
import { env } from "@nightlife/config/env";
import { apiError, clientIp, parseBody, rateLimit } from "@/lib/api";

/**
 * El endpoint público del bot.
 *
 * Es la superficie más expuesta del sistema y la única que cuesta dinero por
 * petición, así que lleva tres frenos: token de conversación firmado, límite
 * por IP y por conversación, y presupuesto diario por club. Cuando el
 * presupuesto se agota el bot no se calla: degrada a plantillas y sigue
 * vendiendo.
 *
 * ── Propiedad ────────────────────────────────────────────────────────
 * Quien escribe aquí NO está autenticado: es un visitante de un perfil
 * público. No hay Principal, y no se fabrica uno — el dueño se resuelve en
 * el servidor a partir de los slugs, que se validan contra la base de datos
 * antes de usarlos. Toda la escritura pasa por `@nightlife/db/webchat`, que
 * abre una transacción con las variables de RLS fijadas.
 *
 * El cuerpo de la petición no lleva ni puede llevar `ownerType`,
 * `ownerClubId` ni `ownerPromoterId`: no están en el esquema de Zod, así que
 * si llegaran se descartarían antes de tocar nada.
 */

const schema = z.object({
  clubSlug: z.string().min(1).max(64),
  promoterSlug: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(1000),
  /** Token devuelto en la primera respuesta. Ata los turnos siguientes. */
  chatToken: z.string().optional(),
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const ip = clientIp(request);
    rateLimit(`chat:ip:${ip}`, 30, 60);

    const body = await parseBody(request, schema);

    // `clubs` no está bajo RLS: es la tabla que resuelve el slug y tiene que
    // poder leerse antes de fijar ningún club. `ai_configs` SÍ lo está, así
    // que el presupuesto diario NO puede venir en un `include` desde aquí:
    // con nl_app volvería `null` sin dar error y `overBudget` sería siempre
    // `false` — el tope de gasto del club dejaría de existir en silencio. Se
    // lee más abajo, dentro de la transacción que ya se abre con el club
    // fijado para construir el contexto.
    const club = await prisma.club.findUnique({ where: { slug: body.clubSlug } });
    if (!club || club.status !== "ACTIVE") throw AppError.notFound("Club");
    if (!club.botEnabled) {
      return NextResponse.json({
        reply: "El asistente todavía no está activo. Escríbenos por WhatsApp o Instagram 👋",
        cta: null,
        chatToken: null,
      });
    }

    // ── De quién es esta conversación ───────────────────────────────
    // Se decide aquí, en el servidor, y no vuelve a cambiar. Si el visitante
    // llega por el perfil de un RRPP aprobado en este club, la conversación
    // es del RRPP y el club es solo el tema del que se habla.
    const { owner, contextClubId, viaPromoterId } = await resolveWebchatOwner({
      clubId: club.id,
      promoterSlug: body.promoterSlug ?? null,
    });

    // ── Beta cerrada ────────────────────────────────────────────────
    // Fuera de la beta, el asistente es una feature de pago del promoter:
    // es nuestro producto y cuesta dinero por conversación, así que sin plan
    // que lo incluya su link seguiría funcionando como escaparate —y
    // llevando al checkout— pero el bot no respondería en su nombre.
    //
    // Durante la beta cerrada no hay Stripe ni planes que contratar: los
    // invitados no tienen fila en `subscriptions`, así que esta comprobación
    // les cortaba el asistente entero. Que es justo lo que están aquí para
    // probar.
    //
    // El interruptor es BETA_CERRADA en packages/core/billing.ts.
    // `assistantAvailable` devuelve `true` mientras esté encendido y vuelve
    // a mirar el plan cuando se apague. No se ha borrado nada de la
    // infraestructura de suscripción: sigue entera y sigue compilando.
    if (owner.type === "PROMOTER") {
      const subscription = await getSubscriptionState("PROMOTER", owner.promoterId);
      if (!assistantAvailable(subscription)) {
        return NextResponse.json({
          reply: null,
          assistantUnavailable: true,
          cta: null,
          chatToken: null,
        });
      }
    }

    // ── Conversación ────────────────────────────────────────────────
    let previousConversationId: string | null = null;
    if (body.chatToken) {
      const claims = await verifyChatToken(body.chatToken, env().AUTH_SECRET);
      if (claims && claims.clubId === club.id) previousConversationId = claims.conversationId;
    }

    // El identificador del visitante se hashea con pepper y con el id del
    // DUEÑO, no del club: el mismo navegador escribiendo a Javier y a MON
    // son dos clientes distintos que no se pueden cruzar.
    const ownerSalt = owner.type === "CLUB" ? owner.clubId : owner.promoterId;
    const visitorHash = await hashCustomerHandle(
      `${ip}|${request.headers.get("user-agent") ?? ""}`,
      `${env().CUSTOMER_HASH_PEPPER}:${ownerSalt}`,
    );

    const session = await openWebchatSession({
      owner,
      contextClubId,
      visitorHash,
      retentionDays: env().CONVERSATION_RETENTION_DAYS,
      conversationId: previousConversationId,
      viaPromoterId,
    });

    rateLimit(`chat:conv:${session.conversationId}`, 20, 60);

    const chatToken = await signChatToken(
      {
        conversationId: session.conversationId,
        clubId: club.id,
        ...(viaPromoterId ? { promoterId: viaPromoterId } : {}),
      },
      env().AUTH_SECRET,
    );

    // Mientras un humano está respondiendo, la IA se calla. Sin excepciones.
    // El mensaje entra igual: que el bot no conteste no puede significar que
    // el cliente escriba al vacío.
    if (session.status === "HUMAN_ACTIVE" || session.status === "WAITING_HUMAN") {
      await recordIncomingMessage({
        owner,
        conversationId: session.conversationId,
        content: body.message,
      });
      return NextResponse.json({ reply: null, waitingHuman: true, chatToken });
    }

    // Lo mismo si el dueño ha apagado la respuesta automática de su webchat.
    if (!session.autoReply) {
      await recordIncomingMessage({
        owner,
        conversationId: session.conversationId,
        content: body.message,
      });
      return NextResponse.json({ reply: null, waitingHuman: true, chatToken });
    }

    // ── Contexto ────────────────────────────────────────────────────
    // Dos lecturas en DOS contextos distintos, y la separación es el punto
    // entero de este bloque:
    //
    //   · el historial es del DUEÑO de la conversación (tabla de propiedad)
    //   · el catálogo es del CLUB del que se habla (datos que ese club ya
    //     publica en su perfil)
    //
    // Para una conversación de club coinciden; para una de RRPP no, y
    // leerlas en el mismo contexto sería o no ver el historial o darle al
    // RRPP un contexto de club que no le toca.
    const partySize = extractPartySize(body.message) ?? session.partySize ?? null;

    const history = await readConversationHistory(owner, session.conversationId);

    // El presupuesto diario viaja en la misma transacción: `ai_configs` está
    // bajo RLS y este es el único sitio del flujo público donde el club ya
    // está fijado. Ni una consulta de más — entra en el `Promise.all`.
    const [context, aiConfig] = await withPublicClubRls(club.id, (tx) =>
      Promise.all([
        buildConversationContext(tx, {
          clubId: club.id,
          eventId: session.eventFocusId,
          promoterId: viaPromoterId,
          conversationId: session.conversationId,
          partySize,
          lastIntent: (session.lastIntent as Intent | null) ?? null,
          priceTtlSeconds: env().PRICE_TTL_SECONDS,
          history,
        }),
        tx.aiConfig.findUnique({
          where: { clubId: club.id },
          select: { spentTodayCents: true, dailyBudgetCents: true },
        }),
      ]),
    );
    if (!context) throw AppError.notFound("Club");

    // ── Motor ───────────────────────────────────────────────────────
    // Fuera de cualquier transacción: llamar al LLM con una conexión de base
    // de datos abierta la retendría segundos enteros del pool.
    const overBudget = aiConfig ? aiConfig.spentTodayCents >= aiConfig.dailyBudgetCents : false;
    const apiKey = env().LLM_API_KEY;

    const result = await runEngine(body.message, context, {
      llm: apiKey ? new AnthropicProvider({ apiKey, model: env().LLM_MODEL }) : null,
      llmDisabled: overBudget,
    });

    // ── Persistencia ────────────────────────────────────────────────
    await persistWebchatTurn({
      owner,
      conversationId: session.conversationId,
      viaPromoterId,
      customerMessage: body.message,
      assistantMessage: result.text,
      intent: result.intent,
      resolvedBy: result.resolvedBy,
      sources: [...new Set(result.facts.provenance.map((p) => p.type))],
      provenance: result.facts.provenance,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      totalLatencyMs: Date.now() - startedAt,
      validationPassed: result.violations.length === 0,
      validationErrors: result.violations.map((v) => v.code),
      partySize,
      eventFocusId: result.eventFocusId,
      purchaseIntent: session.purchaseIntent || result.purchaseIntent,
      requestsHandoff: result.requestsHandoff,
    });

    return NextResponse.json({
      reply: result.text,
      cta: result.cta,
      waitingHuman: result.requestsHandoff,
      chatToken,
    });
  } catch (error) {
    return apiError(error);
  }
}
