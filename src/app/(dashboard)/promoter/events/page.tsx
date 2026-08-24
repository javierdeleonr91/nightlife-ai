import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls, withPublicClubRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { ButtonLink, EmptyState, Icon } from "@/components/ui";
import { EventSelector } from "@/components/event-selector";

/**
 * Selección de eventos del promoter. Solo aparecen los de clubs donde su alta
 * está aprobada: sin eso, cualquiera montaría un escaparate con la marca de un
 * club que no le ha dado permiso.
 */

export const dynamic = "force-dynamic";

/**
 * Los eventos de los clubs que ya aprobaron a este promoter.
 *
 * Dos detalles que costaron una tanda de errores de compilación:
 *
 *  · `promoterClubIds` es `readonly string[]` en el Principal — a propósito,
 *    para que nadie lo modifique por accidente. Prisma pide un array mutable,
 *    así que se copia aquí en lugar de aflojar el tipo del Principal.
 *  · Las relaciones van en el `select` de forma explícita. Así el tipo que
 *    sale de la consulta contiene de verdad `club`, `ticketTypes` y `prices`,
 *    y los callbacks de abajo se tipan solos sin un `any` a la vista.
 */
// Una transacción por club, y no una sola con `clubId: { in: [...] }`.
// El contexto de RLS es UN club: no existe una variable que signifique «estos
// tres». Son pocas consultas —un RRPP trabaja con un puñado de discotecas— y
// la alternativa sería relajar la política, que no se toca.
async function loadAvailableEvents(clubIds: readonly string[]) {
  const porClub = await Promise.all(clubIds.map((clubId) => loadClubEvents(clubId)));
  return porClub
    .flat()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 50);
}

function loadClubEvents(clubId: string) {
  return withPublicClubRls(clubId, (tx) =>
    tx.event.findMany({
    where: {
      clubId,
      startsAt: { gte: new Date() },
      status: "ACTIVE",
    },
    orderBy: { startsAt: "asc" },
    take: 50,
    select: {
      id: true,
      name: true,
      imageUrl: true,
      startsAt: true,
      club: { select: { name: true, timezone: true } },
      ticketTypes: {
        select: {
          status: true,
          prices: { where: { isCurrent: true }, select: { amountCents: true } },
        },
      },
    },
    }),
  );
}

export default async function PromoterEventsPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const [available, selected] = await Promise.all([
    loadAvailableEvents(principal.promoterClubIds),
    withOwnerRls({ type: "PROMOTER", promoterId: principal.promoterId }, (tx) =>
      tx.promoterEvent.findMany({
        where: { promoterId: principal.promoterId },
        select: { eventId: true },
      }),
    ),
  ]);

  const events = available.map((event) => {
    const cents = event.ticketTypes
      .filter((t) => t.status === "AVAILABLE")
      .flatMap((t) => t.prices.map((p) => p.amountCents))
      .sort((a, b) => a - b)[0];
    return {
      id: event.id,
      name: event.name,
      clubName: event.club.name,
      when: `${nightWeekdayEs(event.startsAt, event.club.timezone)} ${formatEventWhen(event.startsAt, event.club.timezone)}`,
      price: cents !== undefined ? formatMoney(money(cents)) : "—",
      imageUrl: event.imageUrl,
    };
  });

  return (
    <Page>
      <PageHeader
        eyebrow="Estos aparecen en tu perfil público"
        title="Mis eventos"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Mis eventos" }]}
      />

      {events.length === 0 ? (
        <EmptyState
          glyph={<Icon name="calendar" size={26} />}
          title="Aún no hay eventos"
          body="Los eventos vienen de las discotecas con las que trabajas. Cuando una discoteca te apruebe y publique una noche en Fourvenues, aparecerá aquí y podrás elegir si quieres mostrarla en tu perfil."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ButtonLink href="/promoter/clubs" variant="hot">
                Ver mis discotecas
              </ButtonLink>
              <ButtonLink href="/promoter/integrations" variant="ghost">
                Configurar Fourvenues
              </ButtonLink>
            </div>
          }
        />
      ) : (
        <EventSelector events={events} initialSelected={selected.map((s) => s.eventId)} />
      )}
    </Page>
  );
}
