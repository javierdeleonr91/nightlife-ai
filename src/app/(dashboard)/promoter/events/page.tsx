import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen } from "@nightlife/core/time";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { EventSelector } from "@/components/event-selector";

/**
 * Selección de eventos del promoter. Solo aparecen los de clubs donde su alta
 * está aprobada: sin eso, cualquiera montaría un escaparate con la marca de un
 * club que no le ha dado permiso.
 */

export const dynamic = "force-dynamic";

export default async function PromoterEventsPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const [available, selected] = await Promise.all([
    prisma.event.findMany({
      where: {
        clubId: { in: principal.promoterClubIds },
        startsAt: { gte: new Date() },
        status: "ACTIVE",
      },
      orderBy: { startsAt: "asc" },
      take: 50,
      include: {
        club: true,
        ticketTypes: { include: { prices: { where: { isCurrent: true } } } },
      },
    }),
    prisma.promoterEvent.findMany({
      where: { promoterId: principal.promoterId },
      select: { eventId: true },
    }),
  ]);

  const selectedIds = selected.map((s) => s.eventId);

  const events = available.map((event) => {
    const cents = event.ticketTypes
      .filter((t) => t.status === "AVAILABLE")
      .flatMap((t) => t.prices.map((p) => p.amountCents))
      .sort((a, b) => a - b)[0];
    return {
      id: event.id,
      name: event.name,
      clubName: event.club.name,
      when: formatEventWhen(event.startsAt, event.club.timezone),
      price: cents !== undefined ? formatMoney(money(cents)) : "—",
    };
  });

  return (
    <main className="mx-auto w-full max-w-md space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">Mis eventos</h1>
        <p className="text-sm text-dash-muted">Los que elijas aparecen en tu link personal.</p>
      </header>

      {events.length === 0 ? (
        <p className="text-sm text-dash-muted">
          No hay eventos disponibles. Puede que tu alta en el club todavía esté pendiente de
          aprobación.
        </p>
      ) : (
        <EventSelector events={events} initialSelected={selectedIds} />
      )}
    </main>
  );
}
