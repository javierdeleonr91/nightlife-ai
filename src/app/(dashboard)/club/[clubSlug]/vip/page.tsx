import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen } from "@nightlife/core/time";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, EmptyState, Icon, Panel } from "@/components/ui";
import { requireClubPage } from "@/lib/club-page";

/**
 * VIP y reservados (§21).
 *
 * Esta pantalla existe porque el asistente **solo** puede contestar sobre VIP
 * lo que esté escrito aquí. Si un reservado no está en esta lista, el bot dirá
 * que no puede confirmarlo en vez de inventarse un precio: por eso la pantalla
 * enseña exactamente lo que la IA va a leer, y no un resumen bonito.
 *
 * No hay checkout de VIP. El VIP se cierra hablando con una persona, y el
 * contacto de reserva es justamente el dato que el bot entrega.
 */

export const dynamic = "force-dynamic";

function loadVipOptions(clubId: string) {
  return withOwnerRls({ type: "CLUB", clubId }, (tx) =>
    tx.vIPOption.findMany({
      where: { clubId },
      // `Event` no tiene `title`: el campo es `name` (ver prisma/schema.prisma).
      include: { event: { select: { id: true, name: true, startsAt: true } } },
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
  );
}

export default async function ClubVipPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { club, base } = await requireClubPage(clubSlug, "club:read");

  const options = await loadVipOptions(club.id);

  const general = options.filter((o) => !o.eventId);
  const perEvent = options.filter((o) => o.eventId);

  return (
    <Page>
      <PageHeader
        eyebrow={club.name}
        title="VIP y reservados"
        back={{ href: `${base}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `${base}/overview` }, { label: "VIP" }]}
        action={
          <Badge tone={options.some((o) => o.isActive) ? "live" : "warn"} dot>
            {options.filter((o) => o.isActive).length} {options.filter((o) => o.isActive).length === 1 ? "activo" : "activos"}
          </Badge>
        }
      />

      {options.length === 0 ? (
        <EmptyState
          glyph={<Icon name="crown" size={26} />}
          title="Aún no hay opciones VIP"
          body="Mientras no haya información aquí, el asistente dirá que no puede confirmar los precios VIP en lugar de inventarlos. Añade tus reservados y packs de botellas para que pueda responder."
        />
      ) : (
        <div className="nl-stagger grid gap-4">
          {general.length > 0 ? (
            <section>
              <p className="nl-eyebrow mb-3">Disponible todas las noches</p>
              <div className="grid gap-3">
                {general.map((option) => (
                  <VipCard key={option.id} option={option} />
                ))}
              </div>
            </section>
          ) : null}

          {perEvent.length > 0 ? (
            <section>
              <p className="nl-eyebrow mb-3">Noches específicas</p>
              <div className="grid gap-3">
                {perEvent.map((option) => (
                  <VipCard key={option.id} option={option} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <Panel className="mt-6">
        <p className="nl-eyebrow mb-2">Cómo utiliza esto el asistente</p>
        <p className="nl-muted text-[0.9375rem]">
          Indica el precio, el número de personas y lo que incluye exactamente como está escrito. Si un
          campo está vacío, lo indicará en lugar de inventar la información. El VIP nunca se vende directamente desde el
          asistente; facilita el contacto de reservas y, cuando sea necesario, pasa la conversación a una persona.
        </p>
      </Panel>
    </Page>
  );
}

/**
 * El tipo sale de la propia consulta.
 *
 * Escribirlo a mano fue el origen del fallo: la lista decía `title` y el modelo
 * dice `name`, y como nadie comparaba las dos cosas, el error solo aparecía al
 * compilar. Derivándolo de la consulta, cambiar el `select` cambia el tipo, y
 * lo que no cuadre se cae en el momento.
 */
type VipOptionRow = Awaited<ReturnType<typeof loadVipOptions>>[number];

function VipCard({ option }: { option: VipOptionRow }) {
  return (
    <article className="nl-card p-5" style={option.isActive ? undefined : { opacity: 0.55 }}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="nl-h3">{option.name}</h2>
          {option.event ? (
            <p className="nl-dim mt-0.5 text-[0.8125rem]">
              {option.event.name} · {formatEventWhen(option.event.startsAt)}
            </p>
          ) : null}
        </div>
        <span className="nl-price nl-price--md">
          {option.priceCents == null ? (
            <span className="nl-dim text-[0.8125rem] font-normal">Consultar</span>
          ) : (
            formatMoney(money(option.priceCents))
          )}
        </span>
      </div>

      {option.description ? (
        <p className="nl-muted mt-2 text-[0.9375rem]">{option.description}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge>
          {option.minPax === option.maxPax
            ? `${option.maxPax} ${option.maxPax === 1 ? "persona" : "personas"}`
            : `${option.minPax}–${option.maxPax} personas`}
        </Badge>
        {option.includes.map((item) => (
          <Badge key={item} tone="violet">
            {item}
          </Badge>
        ))}
        {!option.isActive ? <Badge tone="warn">Oculto</Badge> : null}
      </div>

      {option.conditions ? <p className="nl-hint mt-3">{option.conditions}</p> : null}

      {option.bookingContact ? (
        <p className="nl-dim mt-3 flex items-center gap-2 text-[0.8125rem]">
          <Icon name="chat" size={15} />
          Reservas: <span className="nl-num">{option.bookingContact}</span>
        </p>
      ) : (
        <p className="nl-hint mt-3">
          No hay un contacto de reservas configurado; el asistente ofrecerá pasar la conversación a tu equipo.
        </p>
      )}
    </article>
  );
}
