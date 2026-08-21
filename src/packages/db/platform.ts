import { prisma } from "./client";

/**
 * Operaciones de plataforma: las que cruzan tenants a propósito.
 *
 * El worker de sincronización y los jobs de retención tienen que mirar todos
 * los clubs a la vez, así que no pueden pasar por forTenant. En lugar de
 * darles el cliente crudo —y dejar la puerta abierta a que cualquier otro
 * módulo haga lo mismo— existe esta superficie: pequeña, nombrada y fácil de
 * revisar entera.
 *
 * Regla: aquí solo entran operaciones que necesitan ver varios clubs por su
 * naturaleza. Cualquier cosa que opere sobre un club concreto va en tenant.ts.
 */

export interface DueSource {
  readonly id: string;
  readonly eventId: string;
  readonly sourceUrl: string | null;
  readonly lastSyncedAt: Date | null;
  readonly event: { readonly name: string; readonly startsAt: Date };
}

export async function listSyncCandidates(limit = 100): Promise<DueSource[]> {
  return prisma.eventSource.findMany({
    where: { provider: "fourvenues-public", syncStatus: { not: "UNSUPPORTED" } },
    include: { event: { select: { name: true, startsAt: true } } },
    take: limit,
  });
}

export async function markSourceSynced(sourceId: string): Promise<void> {
  await prisma.eventSource.update({
    where: { id: sourceId },
    data: { lastSyncedAt: new Date(), syncStatus: "OK", lastError: null },
  });
}

/**
 * `permanent` se usa cuando la fuente ha respondido 401/403: se deja de pedir
 * en lugar de reintentar por otra vía, y el club lo ve en su panel.
 */
export async function markSourceFailed(
  sourceId: string,
  message: string,
  permanent: boolean,
): Promise<void> {
  await prisma.eventSource.update({
    where: { id: sourceId },
    data: {
      syncStatus: permanent ? "UNSUPPORTED" : "FAILED",
      lastError: message.slice(0, 500),
      lastSyncedAt: new Date(),
    },
  });
}

/** Cierra eventos pasados para que no aparezcan en las páginas ni gasten sync. */
export async function closeEndedEvents(now = new Date()): Promise<number> {
  const result = await prisma.event.updateMany({
    where: {
      startsAt: { lt: new Date(now.getTime() - 8 * 3600 * 1000) },
      status: { in: ["ACTIVE", "SOLD_OUT"] },
    },
    data: { status: "ENDED" },
  });
  return result.count;
}

/**
 * Retención RGPD. Borra el contenido de las conversaciones vencidas y deja la
 * fila cerrada: los agregados siguen sirviendo y ya no hay dato personal.
 */
export async function anonymizeExpiredConversations(batchSize = 500): Promise<number> {
  const expired = await prisma.conversation.findMany({
    where: { expiresAt: { lt: new Date() }, status: { not: "CLOSED" } },
    select: { id: true },
    take: batchSize,
  });
  if (expired.length === 0) return 0;

  const ids = expired.map((c) => c.id);
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.conversation.updateMany({ where: { id: { in: ids } }, data: { status: "CLOSED" } }),
  ]);
  return ids.length;
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
