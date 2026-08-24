import { prisma } from "./client";
import { channelWhere, ownerFields, ownerWhere, withOwnerRls, type Owner, type OwnerTx } from "./owner";

/**
 * La puerta de entrada del webchat.
 *
 * El visitante de un perfil público NO es un Principal: no ha iniciado
 * sesión, no pertenece a ningún club y no tiene permisos. Por eso este
 * archivo no usa `forOwner(principal, …)` — no hay principal que pasarle, y
 * fabricar uno falso sería abrir un agujero con forma de comodidad.
 *
 * La separación que hay que tener clara todo el rato:
 *
 *   identidad del VISITANTE   ≠   dueño del CANAL
 *
 * El dueño se resuelve **en el servidor** a partir del recurso público que
 * recibe la petición (el slug del club o el del RRPP, ya validados contra la
 * base de datos). Nunca llega en el cuerpo de la petición y nunca se deduce
 * de nada que el navegador pueda inventarse.
 *
 * La cadena es siempre la misma:
 *
 *   perfil público → Channel(WEBCHAT) → Customer → Conversation → Message
 *
 * El canal es el punto de entrada, no un detalle: de él cuelga el dueño de
 * todo lo demás, y los triggers de PostgreSQL comprueban esa cadena en cada
 * escritura.
 */

/** Un canal de webchat por dueño. No uno por conversación. */
const WEBCHAT = "WEBCHAT" as const;

export interface WebchatSession {
  readonly channelId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly status: string;
  readonly lastIntent: string | null;
  readonly eventFocusId: string | null;
  readonly partySize: number | null;
  readonly purchaseIntent: boolean;
  readonly autoReply: boolean;
}

/**
 * El canal de webchat del dueño, creándolo la primera vez.
 *
 * `findFirst` y luego `create` en vez de `upsert` a propósito: la unicidad
 * de un canal de RRPP es `(promoterId, type)` y `promoterId` es nullable, así
 * que la clave compuesta no es un sitio cómodo donde apoyarse. La carrera —
 * dos visitantes a la vez en un perfil que aún no tiene canal — la resuelve
 * el índice único: si el `create` choca, releemos y usamos el que ganó.
 */
async function getOrCreateWebchatChannel(tx: OwnerTx, owner: Owner): Promise<{ id: string; autoReply: boolean }> {
  const where = { ...channelWhere(owner), type: WEBCHAT };

  const existing = await tx.channel.findFirst({ where, select: { id: true, autoReply: true } });
  if (existing) return existing;

  try {
    return await tx.channel.create({
      data:
        owner.type === "CLUB"
          ? { ownerType: "CLUB", clubId: owner.clubId, type: WEBCHAT, status: "CONNECTED" }
          : { ownerType: "PROMOTER", promoterId: owner.promoterId, type: WEBCHAT, status: "CONNECTED" },
      select: { id: true, autoReply: true },
    });
  } catch {
    // Otro visitante lo creó entre el findFirst y el create. No es un error:
    // es exactamente lo que el índice único está para impedir.
    const raced = await tx.channel.findFirst({ where, select: { id: true, autoReply: true } });
    if (raced) return raced;
    throw new Error("No se pudo resolver el canal de webchat");
  }
}

export interface OpenWebchatArgs {
  /** Resuelto en el servidor desde el recurso público. Jamás del cliente. */
  readonly owner: Owner;
  /**
   * De qué club se habla. Es contexto semántico, NO autorización: no aparece
   * en ninguna política de RLS y no da acceso a nada.
   */
  readonly contextClubId: string | null;
  /** Identidad del visitante, ya hasheada con pepper. Nunca en claro. */
  readonly visitorHash: string;
  readonly retentionDays: number;
  /** Conversación en curso, si el token firmado traía una. */
  readonly conversationId?: string | null;
  /** Legacy: por qué RRPP llegó el visitante. No es el dueño. */
  readonly viaPromoterId?: string | null;
}

/**
 * Abre (o continúa) la conversación de webchat de un visitante.
 *
 * Todo dentro de UNA transacción con las variables de RLS fijadas, así que
 * las políticas se aplican a cada lectura y a cada escritura. Si el
 * `conversationId` que llega en el token firmado fuera de otro dueño, la
 * política lo hace invisible y aquí simplemente se abre una conversación
 * nueva — no hace falta comprobarlo a mano, y por eso no se puede olvidar.
 */
export function openWebchatSession(args: OpenWebchatArgs): Promise<WebchatSession> {
  const { owner, contextClubId, visitorHash, retentionDays } = args;

  return withOwnerRls(owner, async (tx) => {
    const channel = await getOrCreateWebchatChannel(tx, owner);
    const scope = ownerWhere(owner);

    // ── Continuar una conversación existente ──────────────────────────
    if (args.conversationId) {
      const previous = await tx.conversation.findFirst({
        where: { id: args.conversationId, ...scope, channelId: channel.id },
        select: {
          id: true, customerId: true, status: true, lastIntent: true,
          eventFocusId: true, partySize: true, purchaseIntent: true,
        },
      });
      if (previous) {
        return {
          channelId: channel.id,
          customerId: previous.customerId,
          conversationId: previous.id,
          status: previous.status,
          lastIntent: previous.lastIntent,
          eventFocusId: previous.eventFocusId,
          partySize: previous.partySize,
          purchaseIntent: previous.purchaseIntent,
          autoReply: channel.autoReply,
        };
      }
    }

    // ── Cliente con alcance de canal ──────────────────────────────────
    // La identidad es `(channelId, externalUserHash)`: el mismo navegador
    // escribiendo al canal de Javier y al de MON son dos clientes distintos,
    // y es lo correcto — sus conversaciones no deben cruzarse nunca.
    //
    // `ownerType` va explícito porque el modelo lo exige, pero sale del canal
    // que acabamos de resolver, no de la petición. El trigger de PostgreSQL
    // vuelve a compararlo con el del canal y rechaza la fila si no cuadra:
    // dos comprobaciones para el mismo invariante, a propósito.
    const customer = await tx.customer.upsert({
      where: { channelId_externalUserHash: { channelId: channel.id, externalUserHash: visitorHash } },
      create: {
        channelId: channel.id,
        externalUserHash: visitorHash,
        ...ownerFields(owner),
        // ── LEGACY ────────────────────────────────────────────────────
        // Se rellenan solo cuando el dueño es un club, que es lo único que
        // el modelo antiguo sabía representar. Para un RRPP se quedan a
        // NULL: es justo lo que el cortafuegos del rollback comprueba antes
        // de dejar volver atrás.
        ...(owner.type === "CLUB"
          ? { clubId: owner.clubId, channelType: WEBCHAT, externalHandleHash: visitorHash }
          : {}),
      },
      update: {},
      select: { id: true },
    });

    // ── Conversación ──────────────────────────────────────────────────
    const conversation = await tx.conversation.create({
      data: {
        ...ownerFields(owner),
        channelId: channel.id,
        customerId: customer.id,
        channelType: WEBCHAT,
        // Contexto, no autorización. Puede cambiar durante la conversación;
        // el dueño no.
        contextClubId,
        // Retención RGPD decidida al crear, no «algún día limpiamos».
        expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
        // ── LEGACY ────────────────────────────────────────────────────
        ...(owner.type === "CLUB" ? { clubId: owner.clubId } : {}),
        ...(args.viaPromoterId ? { promoterId: args.viaPromoterId } : {}),
      },
      select: {
        id: true, customerId: true, status: true, lastIntent: true,
        eventFocusId: true, partySize: true, purchaseIntent: true,
      },
    });

    return {
      channelId: channel.id,
      customerId: conversation.customerId,
      conversationId: conversation.id,
      status: conversation.status,
      lastIntent: conversation.lastIntent,
      eventFocusId: conversation.eventFocusId,
      partySize: conversation.partySize,
      purchaseIntent: conversation.purchaseIntent,
      autoReply: channel.autoReply,
    };
  });
}

/** Un mensaje entrante cuando la IA no debe responder (humano al mando). */
export function recordIncomingMessage(args: {
  readonly owner: Owner;
  readonly conversationId: string;
  readonly content: string;
}): Promise<void> {
  const scope = ownerWhere(args.owner);

  return withOwnerRls(args.owner, async (tx) => {
    await tx.message.create({
      data: {
        conversationId: args.conversationId,
        role: "CUSTOMER",
        content: args.content,
        ...ownerFields(args.owner),
        ...(args.owner.type === "CLUB" ? { clubId: args.owner.clubId } : {}),
      },
    });
    await tx.conversation.updateMany({
      where: { id: args.conversationId, ...scope },
      data: { lastMessageAt: new Date() },
    });
  });
}

/**
 * Los últimos turnos, leídos DENTRO del contexto del dueño.
 *
 * `messages` es una tabla de propiedad: para una conversación de RRPP no se
 * puede leer desde el contexto del club cuyo catálogo se está consultando.
 * Por eso el historial se lee aquí y se le pasa a
 * `buildConversationContext` como dato, en vez de que lo consulte él.
 */
export function readConversationHistory(
  owner: Owner,
  conversationId: string,
  take = 6,
): Promise<{ role: string; content: string; intent: string | null }[]> {
  return withOwnerRls(owner, (tx) =>
    tx.message.findMany({
      where: {
        conversationId,
        ...ownerWhere(owner),
        role: { in: ["CUSTOMER", "ASSISTANT"] },
      },
      orderBy: { createdAt: "desc" },
      take,
      select: { role: true, content: true, intent: true },
    }),
  );
}

export interface PersistTurnArgs {
  readonly owner: Owner;
  readonly conversationId: string;
  readonly viaPromoterId?: string | null;
  readonly customerMessage: string;
  readonly assistantMessage: string;
  readonly intent: string;
  readonly resolvedBy: string;
  readonly sources: readonly string[];
  readonly provenance: unknown;
  readonly model: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
  readonly totalLatencyMs: number;
  readonly validationPassed: boolean;
  readonly validationErrors: readonly string[];
  readonly partySize: number | null;
  readonly eventFocusId: string | null;
  readonly purchaseIntent: boolean;
  readonly requestsHandoff: boolean;
}

/**
 * Guarda el turno completo: los dos mensajes, el estado de la conversación y
 * el registro de observabilidad.
 *
 * Todo en una transacción con RLS: o entra el turno entero o no entra nada.
 * Un mensaje de cliente guardado sin su respuesta sería una conversación
 * corrupta, y peor, silenciosamente corrupta.
 *
 * **El dueño de cada fila se deriva de la conversación, nunca del cliente.**
 * Va explícito porque el modelo lo exige, pero sale de `args.owner`, que se
 * resolvió en el servidor desde el perfil público. El `where` de los
 * `updateMany` lleva además el filtro de dueño: redundante con RLS y puesto
 * a propósito, por si algún día esto corriera contra una conexión sin
 * políticas.
 */
export function persistWebchatTurn(args: PersistTurnArgs): Promise<void> {
  const scope = ownerWhere(args.owner);
  const fields = ownerFields(args.owner);
  const legacyClub = args.owner.type === "CLUB" ? { clubId: args.owner.clubId } : {};

  return withOwnerRls(args.owner, async (tx) => {
    await tx.message.create({
      data: {
        conversationId: args.conversationId,
        role: "CUSTOMER",
        content: args.customerMessage,
        intent: args.intent,
        ...fields,
        ...legacyClub,
      },
    });

    await tx.message.create({
      data: {
        conversationId: args.conversationId,
        role: "ASSISTANT",
        content: args.assistantMessage,
        intent: args.intent,
        // Trazabilidad interna: por qué el bot dijo lo que dijo. No se
        // muestra al cliente.
        provenanceJson: { sources: args.provenance, resolvedBy: args.resolvedBy } as never,
        model: args.model,
        tokensIn: args.tokensIn,
        tokensOut: args.tokensOut,
        latencyMs: args.latencyMs,
        validationPassed: args.validationPassed,
        ...fields,
        ...legacyClub,
      },
    });

    await tx.conversation.updateMany({
      where: { id: args.conversationId, ...scope },
      data: {
        lastIntent: args.intent,
        lastMessageAt: new Date(),
        partySize: args.partySize,
        eventFocusId: args.eventFocusId,
        purchaseIntent: args.purchaseIntent,
        ...(args.requestsHandoff ? { status: "WAITING_HUMAN" as const } : {}),
      },
    });

    // Log de observabilidad, sin una sola palabra del cliente.
    await tx.aiRequestLog.create({
      data: {
        conversationId: args.conversationId,
        intent: args.intent,
        resolvedBy: args.resolvedBy,
        sources: [...args.sources],
        model: args.model,
        tokensIn: args.tokensIn,
        tokensOut: args.tokensOut,
        latencyMs: args.totalLatencyMs,
        validationPassed: args.validationPassed,
        validationErrors: [...args.validationErrors],
        ...fields,
        ...legacyClub,
        ...(args.viaPromoterId ? { promoterId: args.viaPromoterId } : {}),
      },
    });
  });
}

/**
 * Decide de quién es una conversación de webchat a partir del recurso
 * público que la origina.
 *
 * Un visitante que escribe desde el perfil de Javier habla con Javier: la
 * conversación es de Javier y el club solo es el tema. Un visitante que
 * escribe desde el perfil de MON habla con MON.
 *
 * Consecuencia buscada, y conviene decirla en voz alta: **el club NO ve los
 * DM que un cliente le manda a un RRPP**, aunque en ellos se hable del club.
 * Es el mismo principio que en Instagram, y es la razón de que
 * `contextClubId` exista separado del dueño.
 *
 * El RRPP tiene que estar dado de alta y aprobado en el club para prestarle
 * su nombre al asistente; si no lo está, la conversación es del club.
 */
export async function resolveWebchatOwner(args: {
  readonly clubId: string;
  readonly promoterSlug?: string | null;
}): Promise<{ owner: Owner; contextClubId: string; viaPromoterId: string | null }> {
  if (!args.promoterSlug) {
    return { owner: { type: "CLUB", clubId: args.clubId }, contextClubId: args.clubId, viaPromoterId: null };
  }

  // `promoters` no está bajo RLS: resolver un slug público es lo primero que
  // pasa y no puede depender de haber fijado nada.
  const promoter = await prisma.promoter.findUnique({
    where: { slug: args.promoterSlug },
    select: { id: true },
  });
  if (!promoter) {
    return { owner: { type: "CLUB", clubId: args.clubId }, contextClubId: args.clubId, viaPromoterId: null };
  }

  // El alta, en cambio, SÍ: `promoter_clubs` está bajo RLS.
  //
  // Esto estaba mal y era el fallo más caro de los tres. Antes el alta venía
  // en un `select` anidado desde `prisma.promoter`, que no tiene políticas;
  // con nl_app esa relación vuelve **vacía** sin dar error, así que
  // `promoter.clubs.length === 0` sería cierto SIEMPRE y el `return` de
  // abajo se ejecutaría para todo el mundo.
  //
  // Consecuencia: todas las conversaciones del webchat de un RRPP pasarían a
  // ser del CLUB. No un error 500, no un log: el bot contestaría en nombre
  // del club en el perfil del RRPP, y el club vería en su bandeja los DM que
  // los clientes le mandan al RRPP. Que es exactamente lo único que el
  // modelo de propiedad polimórfica existe para impedir.
  //
  // Se lee en contexto de PROMOTER, no de club: es SU alta, y la política de
  // dos caras de la migración 011 la hace visible desde
  // `app.current_promoter_id`. Fijar el club aquí también funcionaría, pero
  // diría algo falso — que quien pregunta es el club.
  const alta = await withOwnerRls({ type: "PROMOTER", promoterId: promoter.id }, (tx) =>
    tx.promoterClub.count({
      where: { promoterId: promoter.id, clubId: args.clubId, status: "APPROVED" },
    }),
  );

  if (alta === 0) {
    return { owner: { type: "CLUB", clubId: args.clubId }, contextClubId: args.clubId, viaPromoterId: null };
  }

  return {
    owner: { type: "PROMOTER", promoterId: promoter.id },
    contextClubId: args.clubId,
    viaPromoterId: promoter.id,
  };
}
