import { notFound } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import { assertTenantAccess, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, ButtonLink, EmptyState, Icon, StatTile } from "@/components/ui";

/**
 * "Hoy" — la portada del panel del club.
 *
 * No es un dashboard de métricas: es el estado de la noche. Arriba, el
 * próximo evento como cartel, porque es de lo que se habla hoy. Debajo, cuatro
 * estados y ninguna gráfica. Y si hay alguien esperando a una persona, eso es
 * lo que grita.
 */

export const dynamic = "force-dynamic";

export default async function OverviewPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertTenantAccess(principal, club.id);

  // Las cuatro consultas van en UNA transacción con el club fijado: son
  // todas de tablas bajo RLS, y sacarlas del contexto significaría cuatro
  // resultados vacíos sin ningún error.
  const [nextEvent, activeEvents, waitingHuman, source] = await withOwnerRls(
    { type: "CLUB", clubId: club.id },
    (tx) =>
      Promise.all([
        tx.event.findFirst({
          where: {
            clubId: club.id,
            startsAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) },
            status: { in: ["ACTIVE", "SOLD_OUT"] },
          },
          orderBy: { startsAt: "asc" },
          include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
        }),
        tx.event.count({
          where: { clubId: club.id, status: "ACTIVE", startsAt: { gte: new Date() } },
        }),
        tx.conversation.count({
          where: { ownerType: "CLUB", ownerClubId: club.id, status: "WAITING_HUMAN" },
        }),
        tx.eventSource.findFirst({ where: { clubId: club.id }, orderBy: { lastSyncedAt: "desc" } }),
      ]),
  );

  const price = nextEvent?.ticketTypes
    .filter((t) => t.status === "AVAILABLE")
    .flatMap((t) => t.prices.map((p) => p.amountCents))
    .sort((a, b) => a - b)[0];

  const sourceOk = source?.syncStatus === "OK";

  return (
    <Page wide>
      <PageHeader
        eyebrow={club.city}
        title="Hoy"
        action={
          <ButtonLink href={`/club/${club.slug}/events`} variant="quiet">
            <Icon name="calendar" size={18} />
            Eventos
          </ButtonLink>
        }
      />

      {waitingHuman > 0 ? (
        // Lo único que interrumpe. Si hay gente esperando, es lo primero.
        <ButtonLink href={`/club/${club.slug}/assistant`} variant="hot" block>
          <Icon name="chat" size={18} />
          {waitingHuman} {waitingHuman === 1 ? "persona espera" : "personas esperan"} respuesta
        </ButtonLink>
      ) : null}

      {nextEvent ? (
        <section className="nl-card nl-enter mt-6">
          <div className="relative aspect-[16/9] sm:aspect-[21/8]">
            {nextEvent.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagen del club
              <img
                src={nextEvent.imageUrl}
                alt=""
                className="h-full w-full object-cover"
                decoding="async"
              />
            ) : (
              <div className="nl-flyer-fallback">
                <span>{club.name.slice(0, 2)}</span>
              </div>
            )}
            <div className="nl-event__veil" />

            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 p-6 sm:p-8">
              <div className="min-w-0">
                <p className="nl-eyebrow" style={{ color: "var(--nl-hot-ink)" }}>
                  Próxima noche · {nightWeekdayEs(nextEvent.startsAt, club.timezone)}{" "}
                  {formatEventWhen(nextEvent.startsAt, club.timezone)}
                </p>
                <h2 className="nl-display mt-2 text-[clamp(1.6rem,5vw,2.4rem)] leading-none">
                  {nextEvent.name}
                </h2>
                {nextEvent.djLineup.length > 0 ? (
                  <p className="nl-muted mt-2 truncate">{nextEvent.djLineup.join(" · ")}</p>
                ) : null}
              </div>

              <div className="text-right">
                <p className="nl-eyebrow">Ahora</p>
                <p className="nl-price nl-price--xl mt-1">
                  {price !== undefined ? formatMoney(money(price)) : "—"}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 p-5">
            <Badge tone={club.botEnabled ? "live" : "warn"} dot pulse={club.botEnabled}>
              {club.botEnabled ? "Asistente activo" : "Asistente apagado"}
            </Badge>
            <ButtonLink href={`/club/${club.slug}/events/${nextEvent.id}`} variant="ghost">
              Ver evento
              <Icon name="arrow" size={16} />
            </ButtonLink>
          </div>
        </section>
      ) : (
        <div className="mt-6">
          <EmptyState
            glyph={<Icon name="bolt" size={26} />}
            title="Todavía no hay ninguna noche"
            body="Importa tu primer evento de Fourvenues y deja que el asistente empiece a vender por ti."
            action={
              <ButtonLink href={`/club/${club.slug}/events`} variant="hot" size="lg">
                <Icon name="plus" size={18} />
                Importar evento
              </ButtonLink>
            }
          />
        </div>
      )}

      <section className="nl-stagger mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Asistente"
          value={club.botEnabled ? "Activo" : "Apagado"}
          tone={club.botEnabled ? "live" : "warn"}
        />
        <StatTile
          label="Fourvenues"
          value={!source ? "Sin conectar" : sourceOk ? "Al día" : "Con fallos"}
          tone={!source ? "warn" : sourceOk ? "live" : "crit"}
          hint={
            source?.lastSyncedAt
              ? source.lastSyncedAt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
              : undefined
          }
        />
        <StatTile label="Eventos activos" value={String(activeEvents)} />
        <StatTile
          label="Esperando"
          value={String(waitingHuman)}
          tone={waitingHuman > 0 ? "crit" : "live"}
        />
      </section>
    </Page>
  );
}
