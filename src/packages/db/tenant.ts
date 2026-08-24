import { AppError } from "@nightlife/core/errors";
import { belongsToTenant, can, type Permission, type Principal } from "@nightlife/core/rbac";
import { prisma } from "./client";
import { withOwnerRls, type OwnerTx } from "./owner";

type TenantClient = OwnerTx;

/**
 * Acceso a datos con el tenant incrustado.
 *
 * La idea: que sea imposible escribir una consulta sin filtro de club. No hay
 * un `db` global que importar; hay `forTenant(principal, clubId)` que ya lleva
 * el where puesto. Olvidarse del filtro deja de ser posible por descuido.
 *
 * ── RLS ──────────────────────────────────────────────────────────────
 * Desde app-04, cada método corre dentro de `withOwnerRls({type:'CLUB'})`.
 *
 * Antes usaba el cliente global sin fijar ninguna variable, y con las
 * políticas activas eso habría sido el fallo más difícil de ver de todo el
 * sistema: consultas válidas, sin error, devolviendo **cero filas**. El
 * panel del club se habría quedado vacío el día de cambiar `DATABASE_URL`, y
 * la primera hipótesis de cualquiera habría sido «se han borrado los datos».
 *
 * El `where` de aplicación se queda además del contexto de RLS. Es
 * redundante a propósito: son dos barreras independientes y ninguna sustituye
 * a la otra.
 */

export interface TenantContext {
  readonly clubId: string;
  readonly principal: Principal;
}

export function assertTenantAccess(principal: Principal, clubId: string): void {
  // 404 y no 403: un 403 confirmaría que ese club existe.
  if (!belongsToTenant(principal, clubId)) throw AppError.notFound("Club");
}

export function assertPermission(principal: Principal, clubId: string, permission: Permission): void {
  assertTenantAccess(principal, clubId);
  if (!can(principal, clubId, permission)) throw AppError.forbidden();
}

export function forTenant(principal: Principal, clubId: string) {
  assertTenantAccess(principal, clubId);
  const where = { clubId };
  /** Todo lo de este repositorio va con el club fijado en la transacción. */
  const scoped = <T>(work: Parameters<typeof withOwnerRls<T>>[1]) =>
    withOwnerRls<T>({ type: "CLUB", clubId }, work);

  return {
    clubId,
    principal,

    club: {
      get: () => scoped((tx) => tx.club.findUnique({ where: { id: clubId } })),
      update: (data: Parameters<TenantClient["club"]["update"]>[0]["data"]) => {
        assertPermission(principal, clubId, "club:update");
        return scoped((tx) => tx.club.update({ where: { id: clubId }, data }));
      },
    },

    events: {
      list: (args?: { onlyUpcoming?: boolean }) =>
        scoped((tx) =>
          tx.event.findMany({
            where: {
              ...where,
              ...(args?.onlyUpcoming
                ? { startsAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) }, status: { in: ["ACTIVE", "SOLD_OUT"] } }
                : {}),
            },
            orderBy: { startsAt: "asc" },
            include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } }, source: true },
          }),
        ),
      get: (eventId: string) =>
        scoped((tx) =>
          tx.event.findFirst({
            where: { id: eventId, ...where },
            include: { ticketTypes: { include: { prices: true } }, source: true, vipOptions: true },
          }),
        ),
      create: (data: Omit<Parameters<TenantClient["event"]["create"]>[0]["data"], "clubId" | "club">) => {
        assertPermission(principal, clubId, "event:write");
        return scoped((tx) => tx.event.create({ data: { ...data, clubId } as never }));
      },
    },

    vipOptions: {
      list: () =>
        scoped((tx) =>
          tx.vIPOption.findMany({ where: { ...where, isActive: true }, orderBy: { sortOrder: "asc" } }),
        ),
    },

    faqs: {
      list: () =>
        scoped((tx) =>
          tx.fAQ.findMany({ where: { ...where, isActive: true }, orderBy: { sortOrder: "asc" } }),
        ),
    },

    conversations: {
      /**
       * El alcance lo decide RBAC: el staff ve todas, el promoter solo las
       * suyas. El filtro no es opcional ni parametrizable desde fuera.
       */
      list: (status?: string) => {
        const alcance = can(principal, clubId, "conversation:read:all")
          ? where
          : { ...where, promoterId: principal.promoterId ?? "__none__" };
        return scoped((tx) =>
          tx.conversation.findMany({
            where: { ...alcance, ...(status ? { status: status as never } : {}) },
            orderBy: { lastMessageAt: "desc" },
            take: 100,
          }),
        );
      },
      get: (conversationId: string) => {
        const alcance = can(principal, clubId, "conversation:read:all")
          ? where
          : { ...where, promoterId: principal.promoterId ?? "__none__" };
        return scoped((tx) =>
          tx.conversation.findFirst({
            where: { id: conversationId, ...alcance },
            include: { messages: { orderBy: { createdAt: "asc" }, take: 50 } },
          }),
        );
      },
    },

    promoters: {
      list: () =>
        scoped((tx) =>
          tx.promoterClub.findMany({ where, include: { promoter: true }, orderBy: { requestedAt: "desc" } }),
        ),
      approve: (promoterClubId: string) => {
        assertPermission(principal, clubId, "promoter:approve");
        return scoped((tx) =>
          tx.promoterClub.updateMany({
            where: { id: promoterClubId, clubId },
            data: { status: "APPROVED", approvedAt: new Date() },
          }),
        );
      },
    },

    // `audit_logs` NO está bajo RLS (ver la nota final de prisma/rls.sql):
    // tiene que poder escribirse aunque todavía no haya club en contexto.
    // Aun así va dentro de la misma transacción, para que un fallo posterior
    // no deje un registro de algo que no llegó a pasar.
    audit: (action: string, meta?: Record<string, unknown>) =>
      scoped((tx) =>
        tx.auditLog.create({
        data: {
          actorId: principal.userId,
          clubId,
          action,
          meta: (meta ?? {}) as never,
          },
        }),
      ),
  };
}

export type TenantDb = ReturnType<typeof forTenant>;

/**
 * Carga el Principal completo de un usuario. Una consulta, no cinco.
 *
 * Esta sí usa el cliente global, y es correcto: `users` y `promoters` están
 * deliberadamente FUERA de RLS (son entidades globales — una persona puede
 * trabajar para varios clubs) y aquí todavía no hay tenant que fijar; de
 * hecho es la consulta que sirve para averiguarlo.
 *
 * ── Y una consulta que NO puede ir en ese include (app-06) ───────────
 * `club_members` sale de RLS en la migración 011 precisamente para que esta
 * consulta funcione: es la tabla de autorización y no puede vivir detrás de
 * la decisión que ella misma resuelve. Con eso, `clubMemberships` se lee
 * aquí sin problema.
 *
 * `promoter_clubs` NO sale de RLS: 011 le da una política de dos caras. Y
 * ahí estaba el fallo. Leída como relación anidada desde `user` —que no
 * tiene políticas— y sin ningún contexto fijado (que es exactamente la
 * situación al iniciar sesión), con `nl_app` vuelve **vacía sin dar error**.
 *
 * Consecuencia: `promoterClubIds` sería `[]` para todos los RRPPs. No un
 * error de login: entrarían bien y se encontrarían el panel sin ningún club
 * y sin ningún evento que elegir, como si no trabajaran con nadie.
 *
 * Se lee aparte, en el contexto del propio RRPP. El `promoterId` sale de la
 * fila `promoters` (tabla sin RLS) del usuario ya autenticado, así que no
 * hay circularidad: para saber qué clubs son suyos hace falta saber quién es
 * él, y eso ya se sabe.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      clubMemberships: true,
      promoter: { select: { id: true } },
    },
  });
  if (!user) return null;

  const promoterId = user.promoter?.id ?? null;

  const promoterClubIds = promoterId
    ? await withOwnerRls({ type: "PROMOTER", promoterId }, (tx) =>
        tx.promoterClub
          .findMany({ where: { promoterId, status: "APPROVED" }, select: { clubId: true } })
          .then((filas) => filas.map((f) => f.clubId)),
      )
    : [];

  return {
    userId: user.id,
    globalRole: user.globalRole,
    clubRoles: new Map(user.clubMemberships.map((m) => [m.clubId, m.role])),
    ...(promoterId ? { promoterId } : {}),
    promoterClubIds,
  };
}
