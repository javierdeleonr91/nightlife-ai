import { notFound } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import { DEFAULT_TTL_SECONDS } from "@nightlife/core/provenance";
import { assertPermission, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page } from "@/components/app-shell";
import { Badge, ButtonLink, Icon, Panel } from "@/components/ui";
import { RefreshButton } from "@/components/refresh-button";

/**
 * Detalle del evento.
 *
 * El flyer a sangre arriba, y encima solo lo que decide una conversación:
 * cuándo es, a cuánto está ahora y si el asistente puede decirlo. Debajo, la
 * escalera de releases, que es la información que ningún otro panel del sector
 * enseña bien.
 *
 * La pieza que más importa aquí es honesta y aburrida: si el precio llegó hace
 * demasiado, se dice en la propia pantalla. El club tiene que poder confiar en
 * que lo que ve es lo que el bot va a contar.
 */

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "live" | "warn" | "crit" | "neutral" }> = {
  ACTIVE: { label: "En venta", tone: "live" },
  SOLD_OUT: { label: "Agotado", tone: "crit" },
  PAUSED: { label: "Pausado", tone: "warn" },
  SYNCING: { label: "Sincronizando", tone: "neutral" },
  ERROR: { label: "Requiere atención", tone: "crit" },
  ENDED: { label: "Finalizado", tone: "neutral" },
};

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ clubSlug: string; eventId: string }>;
}) {
  const { clubSlug, eventId } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertPermission(principal, club.id, "event:read");

  const event = await withOwnerRls({ type: "CLUB", clubId: club.id }, (tx) =>
    tx.event.findFirst({
    where: { id: eventId, clubId: club.id },
    include: {
      source: true,
      ticketTypes: { orderBy: { sortOrder: "asc" }, include: { prices: { orderBy: { validFrom: "asc" } } } },
      vipOptions: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
    },
    }),
  );
  if (!event) notFound();

  const currentPrices = event.ticketTypes
    .map((t) => ({ type: t, price: t.prices.find((p) => p.isCurrent) ?? null }))
    .filter((x) => x.price !== null);

  const available = currentPrices
    .filter((x) => x.type.status === "AVAILABLE")
    .sort((a, b) => (a.price?.amountCents ?? 0) - (b.price?.amountCents ?? 0));

  const currentCents = available[0]?.price?.amountCents ?? null;
  const nextCents =
    currentCents === null
      ? null
      : (currentPrices
          .map((x) => x.price?.amountCents ?? 0)
          .filter((c) => c > currentCents)
          .sort((a, b) => a - b)[0] ?? null);

  // La misma regla de frescura que aplica el motor de IA, mostrada aquí para
  // que el club vea exactamente lo que el bot puede o no puede decir.
  const syncedAt = event.source?.lastSyncedAt ?? event.updatedAt;
  const ageSeconds = Math.floor((Date.now() - syncedAt.getTime()) / 1000);
  const priceIsFresh = ageSeconds < DEFAULT_TTL_SECONDS.currentPrice;
  const isManual = currentPrices.some((x) => x.price?.source === "MANUAL");
  const botCanQuotePrice = currentCents !== null && (isManual || priceIsFresh);

  const status = STATUS[event.status] ?? STATUS.ACTIVE!;

  return (
    <div className="nl-app">
      {/* Cabecera a sangre: el flyer llena el ancho, sin marco ni tarjeta. */}
      <header className="relative">
        <div className="relative aspect-[4/3] sm:aspect-[21/9]">
          {event.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- imagen del club o la fuente
            <img
              src={event.imageUrl}
              alt=""
              className="h-full w-full object-cover"
              decoding="async"
            />
          ) : (
            <div className="nl-flyer-fallback">
              <span>{event.name.slice(0, 2)}</span>
            </div>
          )}
          <div className="nl-event__veil" />
        </div>

        <div className="absolute inset-x-0 top-0 p-5 sm:p-8">
          <ButtonLink href={`/club/${club.slug}/events`} variant="ghost">
            ← Eventos
          </ButtonLink>
        </div>

        <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-3xl px-5 pb-7 sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone} dot pulse={status.tone === "live"}>
              {status.label}
            </Badge>
            {isManual ? <Badge tone="violet">Precio manual</Badge> : null}
          </div>

          <p className="nl-eyebrow mt-3" style={{ color: "var(--nl-hot-ink)" }}>
            {nightWeekdayEs(event.startsAt, club.timezone)} ·{" "}
            {formatEventWhen(event.startsAt, club.timezone)}
          </p>
          <h1 className="nl-display mt-2 text-[clamp(1.9rem,7vw,3rem)] leading-none">{event.name}</h1>
          {event.djLineup.length > 0 ? (
            <p className="nl-muted mt-2">{event.djLineup.join(" · ")}</p>
          ) : null}
        </div>
      </header>

      <Page>
        <div className="nl-stagger grid gap-4">
          {/* Precio */}
          <Panel>
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="nl-eyebrow">Precio actual</p>
                <p className="nl-price nl-price--xl mt-1.5">
                  {currentCents !== null ? formatMoney(money(currentCents)) : "Sin precio"}
                </p>
              </div>
              {nextCents !== null ? (
                <div className="text-right">
                  <p className="nl-eyebrow">Siguiente</p>
                  <p className="nl-price nl-price--md nl-muted mt-1.5">
                    {formatMoney(money(nextCents))}
                  </p>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone={botCanQuotePrice ? "live" : "warn"} dot>
                {botCanQuotePrice ? "El asistente puede indicar este precio" : "El asistente no puede indicar este precio"}
              </Badge>
              <span className="nl-dim text-[0.8125rem]">
                {isManual
                  ? "Lo has establecido manualmente; no caduca."
                  : `Actualizado hace ${formatAge(ageSeconds)}.`}
              </span>
            </div>

            {!botCanQuotePrice ? (
              <p className="nl-hint mt-3">
                Cuando el precio deja de estar actualizado, el asistente deja de indicarlo y ofrece el enlace de compra
                en su lugar. Es preferible no confirmar un precio antes que dar uno incorrecto.
              </p>
            ) : null}
          </Panel>

          {/* Escalera de releases */}
          {event.ticketTypes.length > 0 ? (
            <Panel>
              <p className="nl-eyebrow mb-3">Tramos de venta</p>
              <ul className="grid gap-1.5">
                {event.ticketTypes.map((type) => {
                  const current = type.prices.find((p) => p.isCurrent);
                  const isNow = current?.amountCents === currentCents && type.status === "AVAILABLE";
                  return (
                    <li
                      key={type.id}
                      className="flex items-center justify-between gap-3 rounded-[var(--nl-r-md)] px-4 py-3"
                      style={{
                        background: isNow ? "var(--nl-hot-soft)" : "var(--nl-surface-2)",
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="truncate">{type.name}</span>
                        {isNow ? <Badge tone="hot">Actual</Badge> : null}
                      </span>
                      <span className="flex flex-none items-center gap-3">
                        <span className="nl-num text-[0.875rem]">
                          {current ? formatMoney(money(current.amountCents)) : "—"}
                        </span>
                        <span
                          className="text-[0.75rem] font-semibold uppercase tracking-wider"
                          style={{
                            color:
                              type.status === "AVAILABLE" ? "var(--nl-live)" : "var(--nl-text-4)",
                          }}
                        >
                          {type.status === "AVAILABLE"
                            ? "en venta"
                            : type.status === "SOLD_OUT"
                              ? "agotado"
                              : type.status === "UPCOMING"
                                ? "próximamente"
                                : "?"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}

          {/* Fuente y acciones */}
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="nl-eyebrow">Fuente</p>
                <p className="nl-muted mt-1 truncate text-[0.875rem]">
                  {event.source?.provider === "manual"
                    ? "Introducido manualmente"
                    : (event.source?.sourceUrl ?? "Sin fuente")}
                </p>
                {event.source?.lastError ? (
                  <p className="nl-error mt-1.5 text-[0.8125rem]">{event.source.lastError}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <RefreshButton clubId={club.id} eventId={event.id} />
                {event.ticketUrl ? (
                  <ButtonLink href={event.ticketUrl} variant="quiet" external>
                    <Icon name="ticket" size={17} />
                    Abrir página de compra
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          </Panel>

          {/* VIP */}
          {event.vipOptions.length > 0 ? (
            <Panel>
              <p className="nl-eyebrow mb-3">VIP y reservados</p>
              <ul className="grid gap-1.5">
                {event.vipOptions.map((vip) => (
                  <li
                    key={vip.id}
                    className="flex items-center justify-between gap-3 rounded-[var(--nl-r-md)] bg-[var(--nl-surface-2)] px-4 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{vip.name}</span>
                      <span className="nl-dim text-[0.8125rem]">
                        {vip.minPax}–{vip.maxPax} personas
                      </span>
                    </span>
                    <span className="nl-num flex-none text-[0.9375rem]">
                      {vip.priceCents !== null ? formatMoney(money(vip.priceCents)) : "Consultar"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </Page>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return "menos de un minuto";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
