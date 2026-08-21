import { notFound } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen } from "@nightlife/core/time";
import { assertPermission, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { ImportWizard } from "@/components/import-wizard";

export const dynamic = "force-dynamic";

export default async function EventsPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertPermission(principal, club.id, "event:read");

  const events = await prisma.event.findMany({
    where: { clubId: club.id },
    orderBy: { startsAt: "asc" },
    take: 50,
    include: {
      source: true,
      ticketTypes: { include: { prices: { where: { isCurrent: true } } } },
    },
  });

  return (
    <main className="mx-auto w-full max-w-4xl space-y-10 px-5 py-10">
      <header>
        <h1 className="text-2xl font-bold">Eventos</h1>
        <p className="text-sm text-dash-muted">
          Importa desde Fourvenues o introduce los datos a mano. Nada se publica sin que lo confirmes.
        </p>
      </header>

      <ImportWizard clubId={club.id} clubSlug={club.slug} />

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dash-muted">
          Publicados
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-dash-muted">Todavía no hay eventos.</p>
        ) : (
          <ul className="divide-y divide-dash-line overflow-hidden rounded-xl border border-dash-line bg-dash-surface">
            {events.map((event) => {
              const available = event.ticketTypes
                .filter((t) => t.status === "AVAILABLE")
                .flatMap((t) => t.prices.map((p) => p.amountCents))
                .sort((a, b) => a - b);
              const manual = event.ticketTypes.some((t) => t.prices.some((p) => p.source === "MANUAL"));

              return (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-semibold">{event.name}</p>
                    <p className="text-xs text-dash-muted">
                      {formatEventWhen(event.startsAt, club.timezone)}
                      {event.source?.lastSyncedAt
                        ? ` · sincronizado ${event.source.lastSyncedAt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
                        : " · sin sincronizar"}
                      {manual ? " · precio manual" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-bold tabular-nums">
                      {available[0] !== undefined ? formatMoney(money(available[0])) : "—"}
                    </span>
                    <span className="rounded-full border border-dash-line px-2 py-0.5 text-[11px] uppercase tracking-wide text-dash-muted">
                      {event.status.toLowerCase()}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
