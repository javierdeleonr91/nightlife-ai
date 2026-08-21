import { AppError } from "@nightlife/core/errors";
import { belongsToTenant, can, type Permission, type Principal } from "@nightlife/core/rbac";
import { prisma } from "./client";

/**
 * Acceso a datos con el tenant incrustado.
 *
 * La idea: que sea imposible escribir una consulta sin filtro de club. No hay
 * un `db` global que importar; hay `forTenant(principal, clubId)` que ya lleva
 * el where puesto. Olvidarse del filtro deja de ser posible por descuido.
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

  return {
    clubId,
    principal,

    club: {
      get: () => prisma.club.findUnique({ where: { id: clubId } }),
      update: (data: Parameters<typeof prisma.club.update>[0]["data"]) => {
        assertPermission(principal, clubId, "club:update");
        return prisma.club.update({ where: { id: clubId }, data });
      },
    },

    events: {
      list: (args?: { onlyUpcoming?: boolean }) =>
        prisma.event.findMany({
          where: {
            ...where,
            ...(args?.onlyUpcoming
              ? { startsAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) }, status: { in: ["ACTIVE", "SOLD_OUT"] } }
              : {}),
          },
          orderBy: { startsAt: "asc" },
          include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } }, source: true },
        }),
      get: (eventId: string) =>
        prisma.event.findFirst({
          where: { id: eventId, ...where },
          include: { ticketTypes: { include: { prices: true } }, source: true, vipOptions: true },
        }),
      create: (data: Omit<Parameters<typeof prisma.event.create>[0]["data"], "clubId" | "club">) => {
        assertPermission(principal, clubId, "event:write");
        return prisma.event.create({ data: { ...data, clubId } as never });
      },
    },

    vipOptions: {
      list: () => prisma.vIPOption.findMany({ where: { ...where, isActive: true }, orderBy: { sortOrder: "asc" } }),
    },

    faqs: {
      list: () => prisma.fAQ.findMany({ where: { ...where, isActive: true }, orderBy: { sortOrder: "asc" } }),
    },

    conversations: {
      /**
       * El alcance lo decide RBAC: el staff ve todas, el promoter solo las
       * suyas. El filtro no es opcional ni parametrizable desde fuera.
       */
      list: (status?: string) => {
        const scoped = can(principal, clubId, "conversation:read:all")
          ? where
          : { ...where, promoterId: principal.promoterId ?? "__none__" };
        return prisma.conversation.findMany({
          where: { ...scoped, ...(status ? { status: status as never } : {}) },
          orderBy: { lastMessageAt: "desc" },
          take: 100,
        });
      },
      get: (conversationId: string) => {
        const scoped = can(principal, clubId, "conversation:read:all")
          ? where
          : { ...where, promoterId: principal.promoterId ?? "__none__" };
        return prisma.conversation.findFirst({
          where: { id: conversationId, ...scoped },
          include: { messages: { orderBy: { createdAt: "asc" }, take: 50 } },
        });
      },
    },

    promoters: {
      list: () =>
        prisma.promoterClub.findMany({ where, include: { promoter: true }, orderBy: { requestedAt: "desc" } }),
      approve: (promoterClubId: string) => {
        assertPermission(principal, clubId, "promoter:approve");
        return prisma.promoterClub.updateMany({
          where: { id: promoterClubId, clubId },
          data: { status: "APPROVED", approvedAt: new Date() },
        });
      },
    },

    audit: (action: string, meta?: Record<string, unknown>) =>
      prisma.auditLog.create({
        data: {
          actorId: principal.userId,
          clubId,
          action,
          meta: (meta ?? {}) as never,
        },
      }),
  };
}

export type TenantDb = ReturnType<typeof forTenant>;

/** Carga el Principal completo de un usuario. Una consulta, no cinco. */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      clubMemberships: true,
      promoter: { include: { clubs: { where: { status: "APPROVED" } } } },
    },
  });
  if (!user) return null;

  return {
    userId: user.id,
    globalRole: user.globalRole,
    clubRoles: new Map(user.clubMemberships.map((m) => [m.clubId, m.role])),
    ...(user.promoter ? { promoterId: user.promoter.id } : {}),
    promoterClubIds: user.promoter?.clubs.map((c) => c.clubId) ?? [],
  };
}
