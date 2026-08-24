import { notFound } from "next/navigation";
import { assertPermission, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { EventCardAdmin, type EventCardData } from "@/components/event-card";
import { EmptyState, Icon } from "@/components/ui";
import { ImportExperience } from "@/components/import-experience";

/**
 * Los eventos son contenido visual, no filas.
 *
 * Un club reconoce su fiesta por el flyer antes que por el nombre. Una rejilla
 * de carteles se lee de un vistazo; una tabla obliga a leer. Y el estado va
 * encima del cartel, no en una columna.
 */

export const dynamic = "force-dynamic";

export default async function EventsPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertPermission(principal, club.id, "event:read");

  const events = await withOwnerRls({ type: "CLUB", clubId: club.id }, (tx) =>
    tx.event.findMany({
    where: { clubId: club.id, status: { not: "ENDED" } },
    orderBy: { startsAt: "asc" },
    take: 40,
    include: {
      source: true,
      ticketTypes: { include: { prices: { where: { isCurrent: true } } } },
    },
    }),
  );

  const cards: (EventCardData & { syncLabel?: string })[] = events.map((event) => {
    const available = event.ticketTypes
      .filter((t) => t.status === "AVAILABLE")
      .flatMap((t) => t.prices.map((p) => p.amountCents))
      .sort((a, b) => a - b);
    const manual = event.ticketTypes.some((t) => t.prices.some((p) => p.source === "MANUAL"));

    return {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      imageUrl: event.imageUrl,
      djs: event.djLineup,
      currentPriceCents: available[0] ?? null,
      soldOut:
        event.status === "SOLD_OUT" ||
        (event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.status === "SOLD_OUT")),
      checkoutUrl: event.ticketUrl,
      syncLabel: manual
        ? "precio manual"
        : event.source?.lastSyncedAt
          ? `sinc. ${event.source.lastSyncedAt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
          : "sin sincronizar",
    };
  });

  return (
    <Page wide>
      <PageHeader
        eyebrow={club.name}
        title="Eventos"
        back={{ href: `/club/${club.slug}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `/club/${club.slug}/overview` }, { label: "Eventos" }]}
      />

      {cards.length === 0 ? (
        <EmptyState
          glyph={<Icon name="ticket" size={26} />}
          title="Aún no hay eventos"
          body="Tus eventos están en Fourvenues. Conecta tu cuenta y aparecerán aquí; no tendrás que introducir una misma noche dos veces."
          action={<ImportExperience clubId={club.id} clubSlug={club.slug} />}
        />
      ) : (
        <div className="nl-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <EventCardAdmin
              key={card.id}
              event={card}
              timezone={club.timezone}
              href={`/club/${club.slug}/events/${card.id}`}
              {...(card.syncLabel ? { syncLabel: card.syncLabel } : {})}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
