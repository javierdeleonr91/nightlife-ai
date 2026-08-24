import { AppError } from "@nightlife/core/errors";
import {
  generateInviteCode,
  inviteProblem,
  inviteProblemMessage,
  looksLikeInviteCode,
  normalizeInviteCode,
  usageCondition,
} from "@nightlife/core/invite";
import { prisma } from "./client";

/**
 * Invitaciones de club.
 *
 * La regla de seguridad de todo este módulo cabe en una línea: **el promoter
 * nunca dice a qué club entra**. Manda un código; el código dice el club.
 *
 * Canjear es una transacción. Si dos personas usan el último uso de un código
 * a la vez, solo puede entrar una: el contador se incrementa con una condición
 * dentro de la misma transacción, no leyendo primero y escribiendo después.
 */

export interface InviteView {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: Date | null;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly revokedAt: Date | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

export async function createInvite(args: {
  clubId: string;
  createdById: string;
  /** Días hasta que caduque. Por defecto 30. */
  expiresInDays?: number;
  /** 0 = sin límite. Por defecto un solo uso. */
  maxUses?: number;
  note?: string | null;
}): Promise<InviteView> {
  const expiresInDays = args.expiresInDays ?? 30;

  // Colisión de código: improbable (31^8 ≈ 8·10^11) pero no imposible, y una
  // colisión aquí metería a alguien en el club equivocado. Se reintenta.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode(crypto.getRandomValues(new Uint8Array(16)));
    const taken = await prisma.clubInvite.findUnique({ where: { code }, select: { id: true } });
    if (taken) continue;

    const invite = await prisma.clubInvite.create({
      data: {
        clubId: args.clubId,
        code,
        createdById: args.createdById,
        maxUses: args.maxUses ?? 1,
        note: args.note ?? null,
        expiresAt:
          expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
      },
      select: {
        id: true,
        code: true,
        expiresAt: true,
        maxUses: true,
        usedCount: true,
        revokedAt: true,
        note: true,
        createdAt: true,
      },
    });
    return invite;
  }

  throw new AppError("INTERNAL", "No se pudo generar un código. Inténtalo otra vez.");
}

export async function listInvites(clubId: string): Promise<InviteView[]> {
  return prisma.clubInvite.findMany({
    where: { clubId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      code: true,
      expiresAt: true,
      maxUses: true,
      usedCount: true,
      revokedAt: true,
      note: true,
      createdAt: true,
    },
  });
}

export async function revokeInvite(args: { clubId: string; inviteId: string }): Promise<void> {
  // `updateMany` con el clubId en el where: una petición de otro club no puede
  // revocar esta invitación aunque acierte el id.
  await prisma.clubInvite.updateMany({
    where: { id: args.inviteId, clubId: args.clubId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/*
 * Qué se guarda en `PromoterClub.invitedVia`: el **id** de la fila ClubInvite
 * (un cuid), nunca el código visible.
 *
 * El código es material que circula por WhatsApp, se puede regenerar y se
 * revoca; el id es estable y no dice nada a quien lo vea. Guardar el código
 * ataría la auditoría a un dato que existe para ser compartido.
 */

export interface RedeemResult {
  readonly clubId: string;
  readonly clubName: string;
  readonly clubSlug: string;
  /** Ya pertenecía al club: no es un error, es un «ya estás dentro». */
  readonly alreadyMember: boolean;
}

/**
 * Canjear un código.
 *
 * El promoter entra **aprobado**: el club emitió la invitación, así que la
 * aprobación ya la dio al generarla. Pedirle además que apruebe la solicitud
 * sería hacerle confirmar dos veces lo mismo.
 */
export async function redeemInvite(args: {
  code: string;
  promoterId: string;
}): Promise<RedeemResult> {
  const code = normalizeInviteCode(args.code);
  if (!looksLikeInviteCode(code)) {
    throw AppError.validation(inviteProblemMessage("MALFORMED"));
  }

  return prisma.$transaction(async (tx) => {
    const invite = await tx.clubInvite.findUnique({
      where: { code },
      select: {
        id: true,
        clubId: true,
        revokedAt: true,
        expiresAt: true,
        maxUses: true,
        usedCount: true,
        club: { select: { name: true, slug: true, status: true } },
      },
    });

    // Un código que no existe y uno caducado dan mensajes distintos a
    // propósito: son problemas distintos y la persona hace cosas distintas.
    if (!invite) throw AppError.validation(inviteProblemMessage("MALFORMED"));

    const problem = inviteProblem(invite, new Date());
    if (problem) throw AppError.validation(inviteProblemMessage(problem));

    if (invite.club.status !== "ACTIVE") {
      throw AppError.validation("That club isn't taking promoters right now.");
    }

    const existing = await tx.promoterClub.findUnique({
      where: { promoterId_clubId: { promoterId: args.promoterId, clubId: invite.clubId } },
      select: { id: true, status: true },
    });

    if (existing?.status === "APPROVED") {
      return {
        clubId: invite.clubId,
        clubName: invite.club.name,
        clubSlug: invite.club.slug,
        alreadyMember: true,
      };
    }

    if (existing) {
      // Tenía una solicitud pendiente o rechazada: la invitación la resuelve.
      await tx.promoterClub.update({
        where: { id: existing.id },
        data: { status: "APPROVED", approvedAt: new Date(), invitedVia: invite.id },
      });
    } else {
      /*
       * `upsert` sobre la clave única (promoterId, clubId) en vez de `create`.
       *
       * Entre el `findUnique` de arriba y este `create` cabe otra petición del
       * MISMO promoter con el mismo código — dos pestañas, o un doble toque en
       * el móvil. Con `create` la segunda choca contra la restricción única y
       * sale un error de Prisma en crudo. Con `upsert` la relación converge al
       * mismo estado y nadie ve un fallo por hacer doble clic.
       *
       * La restricción única sigue siendo la que garantiza que no haya dos
       * filas: esto solo evita que su violación se le enseñe a alguien.
       */
      await tx.promoterClub.upsert({
        where: { promoterId_clubId: { promoterId: args.promoterId, clubId: invite.clubId } },
        create: {
          promoterId: args.promoterId,
          clubId: invite.clubId,
          status: "APPROVED",
          approvedAt: new Date(),
          invitedVia: invite.id,
        },
        update: { status: "APPROVED", approvedAt: new Date(), invitedVia: invite.id },
      });
    }

    /*
     * El contador sube dentro de la transacción y, si hay límite, con la
     * condición de que aún queden usos en la MISMA sentencia.
     *
     * Por qué no vale leer y luego escribir: dos peticiones simultáneas leen
     * `usedCount = 0`, las dos deciden que queda un uso y las dos escriben. Con
     * la condición dentro del UPDATE, Postgres serializa: la segunda espera a
     * que la primera confirme, vuelve a evaluar el WHERE contra la fila nueva,
     * ya no se cumple, y actualiza cero filas. Ese cero es el que aborta.
     *
     * `usageCondition` devuelve null cuando el código es ilimitado. Sin esa
     * distinción, `usedCount < 0` no se cumpliría jamás y un código reutilizable
     * no se podría canjear ni una vez.
     */
    const usage = usageCondition(invite.maxUses);
    const consumed = await tx.clubInvite.updateMany({
      where: usage ? { id: invite.id, usedCount: usage } : { id: invite.id },
      // Se incrementa también en los ilimitados: es el único registro de
      // cuánta gente ha entrado por ese código.
      data: { usedCount: { increment: 1 } },
    });
    if (consumed.count === 0) throw AppError.validation(inviteProblemMessage("USED_UP"));

    return {
      clubId: invite.clubId,
      clubName: invite.club.name,
      clubSlug: invite.club.slug,
      alreadyMember: false,
    };
  });
}
