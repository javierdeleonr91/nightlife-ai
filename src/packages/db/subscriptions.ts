import {
  DEFAULT_PLAN_BY_AUDIENCE,
  PLANS,
  TRIAL_DAYS,
  type PlanAudience,
  type SubscriptionState,
} from "@nightlife/core/billing";
import { prisma } from "./client";

/**
 * Suscripciones al software.
 *
 * Lo único que se cobra aquí es el acceso a la herramienta. No hay ningún
 * movimiento de dinero relacionado con las entradas: eso es de Fourvenues, y
 * el promoter es un cliente nuestro, no un afiliado a quien liquidemos nada.
 */

export async function ensurePlansSeeded(): Promise<void> {
  for (const [index, plan] of PLANS.entries()) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      create: {
        code: plan.code,
        name: plan.name,
        audience: plan.audience,
        priceCents: plan.priceCents,
        features: plan.features as unknown as object,
        limits: plan.limits as unknown as object,
        sortOrder: index,
      },
      // Los precios se editan en base de datos, no en el código: un upsert que
      // los pisara borraría un cambio comercial en el siguiente despliegue.
      update: { name: plan.name, features: plan.features as unknown as object, sortOrder: index },
    });
  }
}

/** Alta con periodo de prueba. Se llama al crear un club o un promoter. */
export async function startTrial(
  ownerType: PlanAudience,
  ownerId: string,
  planCode = DEFAULT_PLAN_BY_AUDIENCE[ownerType],
): Promise<void> {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) return; // sin planes sembrados no se bloquea el alta

  await prisma.subscription.upsert({
    where: { ownerType_ownerId: { ownerType, ownerId } },
    create: {
      ownerType,
      ownerId,
      planId: plan.id,
      status: "TRIALING",
      trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
    },
    update: {},
  });
}

export async function getSubscriptionState(
  ownerType: PlanAudience,
  ownerId: string,
): Promise<SubscriptionState | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { ownerType_ownerId: { ownerType, ownerId } },
    include: { plan: true },
  });
  if (!subscription) return null;
  return {
    planCode: subscription.plan.code,
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
  };
}

/**
 * Cierra las pruebas vencidas. Lo llama el worker.
 * No cobra nada: solo cambia el estado. El cobro es cosa de Stripe en Fase 5.
 */
export async function expireFinishedTrials(now = new Date()): Promise<number> {
  const result = await prisma.subscription.updateMany({
    where: { status: "TRIALING", trialEndsAt: { lt: now } },
    data: { status: "CANCELED", canceledAt: now },
  });
  return result.count;
}
