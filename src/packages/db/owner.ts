import { AppError } from "@nightlife/core/errors";
import type { Principal } from "@nightlife/core/rbac";
import { prisma } from "./client";

/**
 * Acceso a datos con propietario polimórfico + RLS.
 *
 * `forTenant` sirve para lo que siempre es de un club: eventos, entradas,
 * FAQs. Esto sirve para lo que puede ser de un club **o** de un RRPP:
 * canales, conversaciones, mensajes, clientes, preguntas sin respuesta.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POR QUÉ TODO VA DENTRO DE UNA TRANSACCIÓN
 *
 * Postgres no tiene «el usuario actual» a efectos de RLS: se lo decimos con
 * una variable de sesión, y las políticas la leen. El problema es que en
 * producción las conexiones **se reutilizan**: Supabase pone un pooler
 * delante, y la conexión que atendió al Club A atiende después al RRPP B.
 *
 * Dos piezas, que solo funcionan juntas:
 *
 *   1. `prisma.$transaction(fn)` — todo lo de dentro va por UNA conexión, y
 *      el pooler la reserva entera mientras dura. Sin esto, dos consultas
 *      seguidas pueden salir por conexiones distintas y la segunda no ve la
 *      variable: cero filas, sin error.
 *
 *   2. `set_config(nombre, valor, true)` — el tercer argumento es lo
 *      importante. `true` = LOCAL a la transacción: Postgres lo revierte
 *      solo al COMMIT o al ROLLBACK, pase lo que pase. Con `false` la
 *      variable sobrevive en la conexión y vuelve el problema de arriba.
 *
 * Y se fijan LAS DOS, siempre, poniendo a cadena vacía la que no toca. Si
 * el pooler nos entrega una conexión donde alguien dejó
 * `app.current_club_id` fijado a nivel de SESIÓN —código viejo, un script,
 * un `SET` suelto—, no fijarla aquí significaría heredarla. La vacía la
 * pisa. Y la cadena vacía no puede conceder nada: un `ownerClubId` nunca es
 * `''`.
 *
 * No hay ningún `RESET` que se pueda olvidar ni un `finally` que se salte
 * una excepción. Lo deshace el motor.
 *
 * Comprobado contra PostgreSQL real en
 * prisma/migrations/manual/tests/rls-pooling-tests.sql, caso 7: la conexión
 * se ensucia a propósito y el RRPP sigue viendo cero filas del club.
 * ─────────────────────────────────────────────────────────────────────
 */

export type Owner =
  | { readonly type: "CLUB"; readonly clubId: string }
  | { readonly type: "PROMOTER"; readonly promoterId: string };

/** Cliente dentro de la transacción: Prisma sin `$transaction` anidado. */
export type OwnerTx = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Cualquier cliente válido para leer: el de una transacción con contexto o,
 * en un script administrativo, el global. Existe para que una función pueda
 * decir «dame por dónde leer» en vez de coger el cliente global por su
 * cuenta — que es exactamente el fallo que RLS convierte en cero filas sin
 * error.
 */
export type DbClient = OwnerTx;

/** El `where` que corresponde al dueño, para las tablas denormalizadas. */
export type OwnerWhere =
  | { readonly ownerType: "CLUB"; readonly ownerClubId: string }
  | { readonly ownerType: "PROMOTER"; readonly ownerPromoterId: string };

export function ownerWhere(owner: Owner): OwnerWhere {
  return owner.type === "CLUB"
    ? { ownerType: "CLUB", ownerClubId: owner.clubId }
    : { ownerType: "PROMOTER", ownerPromoterId: owner.promoterId };
}

/**
 * Los tres campos de dueño, como objeto plano y sin uniones.
 *
 * `ownerWhere` devuelve una unión, que es lo correcto para un `where` pero
 * incómodo de esparcir dentro de un `create`: TypeScript tiene que distribuir
 * la unión por todo el objeto. Aquí se devuelven siempre las tres claves, con
 * `null` en la que no toca — que es exactamente lo que exige el CHECK
 * `..._one_owner` de PostgreSQL: uno lleno, el otro vacío.
 */
export function ownerFields(owner: Owner): {
  ownerType: "CLUB" | "PROMOTER";
  ownerClubId: string | null;
  ownerPromoterId: string | null;
} {
  return {
    ownerType: owner.type,
    ownerClubId: owner.type === "CLUB" ? owner.clubId : null,
    ownerPromoterId: owner.type === "PROMOTER" ? owner.promoterId : null,
  };
}

/** El mismo filtro para `channels`, que guarda el dueño en otras columnas. */
export function channelWhere(owner: Owner) {
  return owner.type === "CLUB"
    ? ({ ownerType: "CLUB", clubId: owner.clubId } as const)
    : ({ ownerType: "PROMOTER", promoterId: owner.promoterId } as const);
}

/**
 * El propietario NUNCA viene del frontend.
 *
 * Se deriva del Principal ya autenticado. Un `ownerId` que llegue en el body
 * de una petición es, como mucho, una sugerencia que hay que comprobar; aquí
 * se comprueba y, si no cuadra, se responde 404 y no 403: un 403 confirmaría
 * que ese club o ese RRPP existen.
 */
export function ownerFor(principal: Principal, requested: Owner): Owner {
  if (requested.type === "CLUB") {
    if (!principal.clubRoles.has(requested.clubId)) throw AppError.notFound("Club");
    return requested;
  }
  if (principal.promoterId !== requested.promoterId) throw AppError.notFound("Promoter");
  return requested;
}

/**
 * Fija las variables de RLS y ejecuta el trabajo.
 *
 * Exportada aparte de `forOwner` porque el motor de conversación y los
 * webhooks necesitan hacer varias escrituras en la misma transacción.
 */
export function withOwnerRls<T>(owner: Owner, work: (tx: OwnerTx) => Promise<T>): Promise<T> {
  const clubId = owner.type === "CLUB" ? owner.clubId : "";
  const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";

  return prisma.$transaction(async (tx) => {
    // Parametrizado, no interpolado: `SET LOCAL` no acepta parámetros, pero
    // `set_config()` es una función normal y sí. Un id con comillas no puede
    // convertirse en SQL.
    await tx.$queryRaw`SELECT set_config('app.current_club_id',     ${clubId},     true)`;
    await tx.$queryRaw`SELECT set_config('app.current_promoter_id', ${promoterId}, true)`;
    return work(tx);
  });
}

/**
 * Leer el catálogo PÚBLICO de un club, sin haber iniciado sesión.
 *
 * Hace falta porque hay lecturas legítimamente anónimas: el perfil público
 * de un club, y el asistente de un RRPP que tiene que saber a qué hora abre
 * MON para poder contestar. Esos datos —eventos, tarifas, FAQs, horario,
 * dress code— son los mismos que cualquiera ve en la página pública. No son
 * información privada del club.
 *
 * Lo que NO es esto:
 *
 *  · No es un bypass. Fija `app.current_club_id` como cualquier otra
 *    transacción y las políticas se aplican igual. Un rol con BYPASSRLS
 *    seguiría siendo un error; esto funciona con `nl_app`.
 *  · No da acceso a las tablas de propiedad. Conversaciones, mensajes y
 *    clientes de un club se filtran por `ownerClubId`, así que dentro de
 *    esta transacción también serían visibles — y por eso la regla es que
 *    aquí dentro **solo se lee catálogo**. Hay un test que comprueba qué
 *    modelos se tocan.
 *  · No lo usa un RRPP para espiar a un club: lo usa el servidor para
 *    responder con la información que el club ya publica.
 *
 * `contextClubId` no interviene en la decisión. El club cuyo catálogo se lee
 * llega como argumento explícito de quien ya lo ha resuelto y validado.
 *
 * Cuando exista una política de lectura pública sobre esas tablas —lo suyo
 * para más adelante— este helper sobra y se borra. Mientras tanto es el
 * mecanismo explícito, con nombre propio y auditable.
 */
export function withPublicClubRls<T>(clubId: string, work: (tx: DbClient) => Promise<T>): Promise<T> {
  return withOwnerRls({ type: "CLUB", clubId }, work);
}


/**
 * Fija el owner dentro de una transacción que YA existe.
 *
 * Solo se usa para bootstrap: por ejemplo, al crear un Club todavía no
 * conocemos su id antes de empezar la transacción, así que no podemos entrar
 * mediante withOwnerRls desde el principio.
 */
export async function setOwnerRlsContextInTx(
  tx: OwnerTx,
  owner: Owner,
): Promise<void> {
  const clubId = owner.type === "CLUB" ? owner.clubId : "";
  const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";

  await tx.$queryRaw`SELECT set_config(${"app.current_club_id"}, ${clubId}, true)`;
  await tx.$queryRaw`SELECT set_config(${"app.current_promoter_id"}, ${promoterId}, true)`;
}

/**
 * Repositorio con el dueño incrustado.
 *
 * Igual que `forTenant`, no expone un `prisma` suelto: cada método abre su
 * transacción, fija las variables y la suelta.
 */
export function forOwner(principal: Principal, requested: Owner) {
  const owner = ownerFor(principal, requested);
  const where = ownerWhere(owner);
  const chWhere = channelWhere(owner);

  return {
    owner,
    principal,

    channels: {
      list: () =>
        withOwnerRls(owner, (tx) => tx.channel.findMany({ where: chWhere, orderBy: { type: "asc" } })),

      /** Estado real de un canal. Nunca se inventa un "Conectado". */
      get: (type: "WEBCHAT" | "INSTAGRAM" | "WHATSAPP") =>
        withOwnerRls(owner, (tx) => tx.channel.findFirst({ where: { ...chWhere, type } })),

      setAutoReply: (channelId: string, autoReply: boolean) =>
        withOwnerRls(owner, (tx) =>
          tx.channel.updateMany({ where: { id: channelId, ...chWhere }, data: { autoReply } }),
        ),
    },

    conversations: {
      list: (args?: { readonly status?: string; readonly take?: number }) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.findMany({
            where: { ...where, ...(args?.status ? { status: args.status as never } : {}) },
            orderBy: { lastMessageAt: "desc" },
            take: args?.take ?? 50,
            include: {
              customer: { select: { displayName: true, locale: true } },
              messages: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          }),
        ),

      get: (conversationId: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.findFirst({
            where: { id: conversationId, ...where },
            include: { messages: { orderBy: { createdAt: "asc" }, take: 100 } },
          }),
        ),

      /** Cuántas esperan a un humano. Es el número del panel. */
      waitingCount: () =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.count({ where: { ...where, status: "WAITING_HUMAN" } }),
        ),

      /**
       * Cambios de estado del handoff. El `updateMany` con el filtro de
       * dueño no es paranoia redundante con RLS: si algún día esto corre
       * contra una conexión sin políticas, el filtro sigue puesto.
       */
      takeOver: (conversationId: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.updateMany({
            where: { id: conversationId, ...where },
            data: { status: "HUMAN_ACTIVE" },
          }),
        ),

      backToAi: (conversationId: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.updateMany({
            where: { id: conversationId, ...where },
            data: { status: "AI_ACTIVE" },
          }),
        ),

      close: (conversationId: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.updateMany({
            where: { id: conversationId, ...where },
            data: { status: "CLOSED" },
          }),
        ),
    },

    unanswered: {
      list: (status: "OPEN" | "ANSWERED" | "DISMISSED" = "OPEN") =>
        withOwnerRls(owner, (tx) =>
          tx.unansweredQuestion.findMany({
            where: { ...where, status },
            orderBy: { createdAt: "desc" },
            take: 100,
          }),
        ),

      openCount: () =>
        withOwnerRls(owner, (tx) => tx.unansweredQuestion.count({ where: { ...where, status: "OPEN" } })),

      dismiss: (id: string) =>
        withOwnerRls(owner, (tx) =>
          tx.unansweredQuestion.updateMany({
            where: { id, ...where },
            data: { status: "DISMISSED", resolvedAt: new Date() },
          }),
        ),
    },

    customers: {
      count: () => withOwnerRls(owner, (tx) => tx.customer.count({ where })),
    },

    feedback: {
      create: (data: {
        readonly kind: "ERROR" | "SUGGESTION" | "INTEGRATION" | "OTHER";
        readonly message: string;
        readonly path?: string | null;
      }) =>
        withOwnerRls(owner, (tx) =>
          tx.betaFeedback.create({
            data: {
              ...where,
              userId: principal.userId,
              kind: data.kind,
              message: data.message,
              path: data.path ?? null,
            },
          }),
        ),
    },

    /**
     * Para operaciones que tocan varias tablas y deben ir juntas. Es el
     * único hueco por el que sale el cliente crudo, y solo dentro de la
     * transacción con las variables ya fijadas.
     */
    tx: <T>(work: (tx: OwnerTx) => Promise<T>) => withOwnerRls(owner, work),
  };
}

export type OwnerDb = ReturnType<typeof forOwner>;

/**
 * Puente legacy.
 *
 * `forTenant(principal, clubId)` es lo que usa todo el código actual y no se
 * reescribe aquí. Esto le pone delante `forOwner` con dueño de tipo CLUB,
 * que es exactamente lo que significaba. El código nuevo llama a `forOwner`
 * directamente; este wrapper desaparece cuando no quede ningún llamante.
 */
export function forOwnerFromTenant(principal: Principal, clubId: string) {
  return forOwner(principal, { type: "CLUB", clubId });
}
