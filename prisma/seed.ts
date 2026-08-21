/**
 * Datos de ejemplo para desarrollo.
 *
 * Monta el caso completo de la sección 67: un club con un evento cuya
 * escalera de releases ya tiene dos agotados, un promoter aprobado y las FAQ
 * por defecto. Sirve para comprobar los 13 pasos del club y los 9 del
 * promoter sin depender de la fuente externa.
 *
 *   npm run db:push && npm run db:seed
 *   → club:      neon@example.com / password123  → /c/club-neon
 *   → promoter:  alex@example.com / password123  → /alex
 */

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/packages/auth/crypto";
import { PLANS, TRIAL_DAYS } from "../src/packages/core/billing";

const prisma = new PrismaClient();

// Próximo sábado a las 23:59 hora de Madrid.
function nextSaturday(): Date {
  const date = new Date();
  date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7 || 7));
  date.setHours(23, 59, 0, 0);
  return date;
}

async function main() {
  const password = await hashPassword("password123");

  // ── planes de software ────────────────────────────────────────────
  // Lo único que factura la plataforma. El dinero de las entradas nunca pasa
  // por aquí: lo cobra Fourvenues directamente al cliente final.
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
      update: {},
    });
  }

  const ownerUser = await prisma.user.upsert({
    where: { email: "neon@example.com" },
    create: { email: "neon@example.com", name: "Marta (Club Neon)", passwordHash: password },
    update: {},
  });

  const club = await prisma.club.upsert({
    where: { slug: "club-neon" },
    create: {
      slug: "club-neon",
      name: "Club Neon",
      description: "Techno y house en el centro de Madrid.",
      city: "Madrid",
      address: "Calle de la Montera 24",
      whatsapp: "+34600111222",
      instagram: "clubneon",
      minAge: 18,
      dressCode: "Nada de chándal ni deportivas de running. El resto, como quieras.",
      openingHours: "Viernes y sábados de 00:00 a 06:00.",
      botEnabled: true,
    },
    update: {},
  });

  await prisma.clubMember.upsert({
    where: { userId_clubId: { userId: ownerUser.id, clubId: club.id } },
    create: { userId: ownerUser.id, clubId: club.id, role: "CLUB_OWNER" },
    update: {},
  });

  await prisma.brandSettings.upsert({
    where: { clubId: club.id },
    create: { clubId: club.id, primaryColor: "#FF2D6F", backgroundColor: "#0B0B10" },
    update: {},
  });

  await prisma.aiConfig.upsert({
    where: { clubId: club.id },
    create: { clubId: club.id },
    update: {},
  });

  // FAQ por defecto generadas desde los campos del club: el onboarding no
  // obliga a escribirlas, pero el bot ya responde desde el minuto uno.
  const faqs = [
    {
      question: "¿Puedo celebrar un cumpleaños?",
      answer: "Sí. Escríbenos por WhatsApp y te lo organizamos.",
      keywords: ["cumple", "cumpleaños", "celebrar", "despedida"],
    },
    {
      question: "¿Hay guardarropa?",
      answer: "Sí, 3 € por prenda.",
      keywords: ["guardarropa", "abrigo", "chaqueta", "ropa"],
    },
    {
      question: "¿Se puede pagar con tarjeta en la barra?",
      answer: "Sí, tarjeta y móvil sin problema.",
      keywords: ["tarjeta", "pagar", "efectivo", "barra"],
    },
  ];
  for (const [index, faq] of faqs.entries()) {
    await prisma.fAQ.create({ data: { ...faq, clubId: club.id, sortOrder: index } });
  }

  await prisma.vIPOption.createMany({
    data: [
      { clubId: club.id, name: "VIP A", priceCents: 35_000, minPax: 6, maxPax: 10, includes: ["2 botellas", "mesa junto a pista"], sortOrder: 0 },
      { clubId: club.id, name: "VIP B", priceCents: 50_000, minPax: 8, maxPax: 14, includes: ["3 botellas", "zona elevada"], sortOrder: 1 },
      { clubId: club.id, name: "VIP C", priceCents: 80_000, minPax: 12, maxPax: 20, includes: ["5 botellas", "reservado privado"], sortOrder: 2 },
    ],
  });

  // Evento con la escalera de releases del caso de prueba: 15 y 18 agotados,
  // 20 a la venta, 25 por salir. El bot debe decir 20 €.
  const event = await prisma.event.create({
    data: {
      clubId: club.id,
      name: "Summer Closing",
      slug: "summer-closing",
      description: "Cierre de temporada.",
      startsAt: nextSaturday(),
      djLineup: ["DJ X", "DJ Y"],
      ticketUrl: "https://fourvenues.com/club-neon/events/summer-closing",
      status: "ACTIVE",
    },
  });

  await prisma.eventSource.create({
    data: {
      eventId: event.id,
      clubId: club.id,
      provider: "manual",
      sourceUrl: "https://fourvenues.com/club-neon/events/summer-closing",
      lastSyncedAt: new Date(),
      syncStatus: "OK",
    },
  });

  const ladder = [
    { name: "Early Bird", cents: 1500, status: "SOLD_OUT" as const },
    { name: "1st Release", cents: 1800, status: "SOLD_OUT" as const },
    { name: "2nd Release", cents: 2000, status: "AVAILABLE" as const },
    { name: "3rd Release", cents: 2500, status: "UPCOMING" as const },
  ];
  for (const [index, tier] of ladder.entries()) {
    const type = await prisma.ticketType.create({
      data: { eventId: event.id, clubId: club.id, name: tier.name, sortOrder: index, status: tier.status },
    });
    await prisma.ticketPrice.create({
      data: {
        ticketTypeId: type.id,
        clubId: club.id,
        amountCents: tier.cents,
        isCurrent: true,
        source: "MANUAL",
        confidence: 1,
      },
    });
  }

  // ── promoter ──────────────────────────────────────────────────────
  const promoterUser = await prisma.user.upsert({
    where: { email: "alex@example.com" },
    create: { email: "alex@example.com", name: "Alex", passwordHash: password },
    update: {},
  });

  const promoter = await prisma.promoter.upsert({
    where: { userId: promoterUser.id },
    create: {
      userId: promoterUser.id,
      slug: "alex",
      displayName: "Alex",
      city: "Madrid",
      bio: "RRPP en Madrid. Te consigo sitio.",
      instagram: "alexmadrid",
      whatsapp: "+34600333444",
    },
    update: {},
  });

  await prisma.promoterClub.upsert({
    where: { promoterId_clubId: { promoterId: promoter.id, clubId: club.id } },
    create: { promoterId: promoter.id, clubId: club.id, status: "APPROVED", approvedAt: new Date() },
    update: {},
  });

  await prisma.promoterEvent.upsert({
    where: { promoterId_eventId: { promoterId: promoter.id, eventId: event.id } },
    create: { promoterId: promoter.id, eventId: event.id, clubId: club.id, referralTag: "alex" },
    update: {},
  });

  // ── suscripciones al software ─────────────────────────────────────
  // El club paga su plan y el promoter el suyo. Ninguno cobra de nosotros.
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
  for (const [ownerType, ownerId, planCode] of [
    ["CLUB", club.id, "CLUB_PRO"],
    ["PROMOTER", promoter.id, "PROMOTER_PRO"],
  ] as const) {
    const plan = await prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) continue;
    await prisma.subscription.upsert({
      where: { ownerType_ownerId: { ownerType, ownerId } },
      create: { ownerType, ownerId, planId: plan.id, status: "TRIALING", trialEndsAt },
      update: {},
    });
  }

  console.log("Listo.");
  console.log("  Club:     http://localhost:3000/c/club-neon   (neon@example.com / password123)");
  console.log("  Promoter: http://localhost:3000/alex          (alex@example.com / password123)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
