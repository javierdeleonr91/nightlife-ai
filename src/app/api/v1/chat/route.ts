import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { runEngine } from "@nightlife/ai/engine";
import { extractPartySize, type Intent } from "@nightlife/ai/intents";
import { AnthropicProvider } from "@nightlife/ai/llm";
import { hasFeature } from "@nightlife/core/billing";
import {
  buildConversationContext,
  getSubscriptionState,
  unsafePrismaForMigrationsOnly as prisma,
} from "@nightlife/db";
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

    const club = await prisma.club.findUnique({
      where: { slug: body.clubSlug },
      include: { aiConfig: true },
    });
    if (!club || club.status !== "ACTIVE") throw AppError.notFound("Club");
    if (!club.botEnabled) {
      return NextResponse.json({
        reply: "El asistente todavía no está activo. Escríbenos por WhatsApp o Instagram 👋",
        cta: null,
        chatToken: null,
      });
    }

    const promoter = body.promoterSlug
      ? await prisma.promoter.findUnique({
          where: { slug: body.promoterSlug },
          include: { clubs: { where: { clubId: club.id, status: "APPROVED" } } },
        })
      : null;
    // Un promoter sin alta aprobada en este club no presta su nombre al bot.
    const promoterId = promoter && promoter.clubs.length > 0 ? promoter.id : null;

    // El asistente es una feature de pago del promoter: es nuestro producto y
    // tiene coste por conversación. Sin plan que lo incluya, su link sigue
    // funcionando como escaparate —y llevando al checkout— pero el bot no
    // responde en su nombre.
    if (promoterId) {
      const subscription = await getSubscriptionState("PROMOTER", promoterId);
      if (!hasFeature(subscription, "ai_assistant")) {
        return NextResponse.json({
          reply: null,
          assistantUnavailable: true,
          cta: null,
          chatToken: null,
        });
      }
    }

    // ── conversación ────────────────────────────────────────────────
    let conversationId: string | null = null;
    if (body.chatToken) {
      const claims = await verifyChatToken(body.chatToken, env().AUTH_SECRET);
      if (claims && claims.clubId === club.id) conversationId = claims.conversationId;
    }

    let conversation = conversationId
      ? await prisma.conversation.findFirst({ where: { id: conversationId, clubId: club.id } })
      : null;

    if (!conversation) {
      // Identificador del visitante hasheado con sal por club: el mismo
      // navegador en dos clubs son dos clientes distintos y no se pueden cruzar.
      const handleHash = await hashCustomerHandle(
        `${ip}|${request.headers.get("user-agent") ?? ""}`,
        `${env().CUSTOMER_HASH_PEPPER}:${club.id}`,
      );
      const customer = await prisma.customer.upsert({
        where: {
          clubId_channelType_externalHandleHash: {
            clubId: club.id,
            channelType: "WEBCHAT",
            externalHandleHash: handleHash,
          },
        },
        create: { clubId: club.id, channelType: "WEBCHAT", externalHandleHash: handleHash },
        update: {},
      });

      conversation = await prisma.conversation.create({
        data: {
          clubId: club.id,
          customerId: customer.id,
          promoterId,
          channelType: "WEBCHAT",
          // Retención RGPD decidida al crear, no "algún día limpiamos".
          expiresAt: new Date(Date.now() + env().CONVERSATION_RETENTION_DAYS * 86_400_000),
        },
      });
    }

    rateLimit(`chat:conv:${conversation.id}`, 20, 60);

    // Mientras un humano está respondiendo, la IA se calla. Sin excepciones.
    if (conversation.status === "HUMAN_ACTIVE" || conversation.status === "WAITING_HUMAN") {
      await prisma.message.create({
        data: { conversationId: conversation.id, clubId: club.id, role: "CUSTOMER", content: body.message },
      });
      return NextResponse.json({
        reply: null,
        waitingHuman: true,
        chatToken: await signChatToken({ conversationId: conversation.id, clubId: club.id }, env().AUTH_SECRET),
      });
    }

    // ── contexto y motor ────────────────────────────────────────────
    const partySize = extractPartySize(body.message) ?? conversation.partySize ?? null;

    const context = await buildConversationContext({
      clubId: club.id,
      eventId: conversation.eventFocusId,
      promoterId,
      conversationId: conversation.id,
      partySize,
      lastIntent: (conversation.lastIntent as Intent | null) ?? null,
      priceTtlSeconds: env().PRICE_TTL_SECONDS,
    });
    if (!context) throw AppError.notFound("Club");

    const budget = club.aiConfig;
    const overBudget = budget ? budget.spentTodayCents >= budget.dailyBudgetCents : false;
    const apiKey = env().LLM_API_KEY;

    const result = await runEngine(body.message, context, {
      llm: apiKey ? new AnthropicProvider({ apiKey, model: env().LLM_MODEL }) : null,
      llmDisabled: overBudget,
    });

    // ── persistencia ────────────────────────────────────────────────
    await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          clubId: club.id,
          role: "CUSTOMER",
          content: body.message,
          intent: result.intent,
        },
      }),
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          clubId: club.id,
          role: "ASSISTANT",
          content: result.text,
          intent: result.intent,
          // Trazabilidad interna: por qué el bot dijo lo que dijo.
          provenanceJson: { sources: result.facts.provenance, resolvedBy: result.resolvedBy } as never,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          validationPassed: result.violations.length === 0,
        },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: result.intent,
          lastMessageAt: new Date(),
          partySize,
          eventFocusId: result.eventFocusId,
          purchaseIntent: conversation.purchaseIntent || result.purchaseIntent,
          status: result.requestsHandoff ? "WAITING_HUMAN" : conversation.status,
        },
      }),
      // Log de observabilidad sin una sola palabra del cliente.
      prisma.aiRequestLog.create({
        data: {
          clubId: club.id,
          promoterId,
          conversationId: conversation.id,
          intent: result.intent,
          resolvedBy: result.resolvedBy,
          sources: [...new Set(result.facts.provenance.map((p) => p.type))],
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: Date.now() - startedAt,
          validationPassed: result.violations.length === 0,
          validationErrors: result.violations.map((v) => v.code),
        },
      }),
    ]);

    return NextResponse.json({
      reply: result.text,
      cta: result.cta,
      waitingHuman: result.requestsHandoff,
      chatToken: await signChatToken(
        { conversationId: conversation.id, clubId: club.id, ...(promoterId ? { promoterId } : {}) },
        env().AUTH_SECRET,
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}
