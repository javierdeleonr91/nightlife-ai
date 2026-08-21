import { PrismaClient } from "@prisma/client";

/**
 * ATENCIÓN
 *
 * Este cliente NO se exporta fuera de @nightlife/db. Todo acceso a datos de un
 * club pasa por forTenant(clubId), que devuelve consultas con el filtro ya
 * aplicado y sin forma de quitarlo.
 *
 * El test de arquitectura (tests/architecture.test.ts) falla el build si algún
 * archivo fuera de este paquete importa PrismaClient. Es la primera de las dos
 * barreras de aislamiento; la segunda es RLS en Postgres (ver prisma/rls.sql).
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
