import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import { BETA_CERRADA, assistantAvailable, isEntitled, planByCode } from "@nightlife/core/billing";
import { promoterCompletion } from "@nightlife/core/completion";
import { getSubscriptionState, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls, withPublicClubRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page } from "@/components/app-shell";
import { Badge, ButtonLink, EmptyState, Icon } from "@/components/ui";
import { ShareLink } from "@/components/share-link";
import { CompletionCard } from "@/components/completion-card";

/**
 * Centro de operaciones del promoter (§20).
 *
 * Se usa de pie, con una mano, en la puerta de un club. Por eso: una columna,
 * objetivos táctiles grandes, y arriba del todo lo que más veces va a hacer en
 * su vida con este producto — compartir su perfil.
 *
 * Debajo, cuatro estados de un vistazo — perfil público, Fourvenues, asistente,
 * clubs — para que no tenga que entrar en cuatro pantallas a comprobar si algo
 * está encendido. Un panel de estado, no una cuenta de resultados.
 *
 * NO hay panel de ventas. El promoter es un cliente que paga por la
 * herramienta, no un afiliado al que liquidemos dinero: quien cobra las
 * entradas es Fourvenues. Los precios que aparecen son el precio de la entrada
 * para el cliente — lo que necesita saber para responder, no ingresos suyos.
 */

export const dynamic = "force-dynamic";

function greeting(hour: number): string {
  if (hour < 6) return "Buenas noches";
  if (hour < 13) return "Buenos días";
  if (hour < 20) return "Buenas tardes";
  return "Buenas noches";
}

export default async function PromoterHome() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  // ── Tres contextos, como en el perfil público (app-06) ──────────────
  // `promoters` y `clubs` no están bajo RLS; `promoter_clubs`,
  // `promoter_events`, `events`, `ticket_types` y `ticket_prices` sí. Un
  // `include` anidado desde `prisma.promoter` los devolvería VACÍOS con
  // nl_app, sin error: este panel saldría diciéndole al RRPP que no trabaja
  // con ningún club y que no tiene ninguna noche elegida.
  const promoter = await prisma.promoter.findUnique({ where: { id: principal.promoterId } });
  if (!promoter) redirect("/onboarding");

  // Lo suyo, en su contexto. Sin fijar ningún club: trabaja con varios y la
  // política de dos caras de 011 lo reconoce como dueño de sus altas.
  const [altas, elegidos] = await withOwnerRls(
    { type: "PROMOTER", promoterId: promoter.id },
    (tx) =>
      Promise.all([
        tx.promoterClub.findMany({
          where: { promoterId: promoter.id },
          select: { id: true, clubId: true, status: true },
        }),
        tx.promoterEvent.findMany({
          where: { promoterId: promoter.id },
          select: { id: true, eventId: true, clubId: true },
        }),
      ]),
  );

  const clubRows = await prisma.club.findMany({
    where: { id: { in: [...new Set(altas.map((a) => a.clubId))] } },
    select: { id: true, name: true, timezone: true },
  });
  const clubById = new Map(clubRows.map((c) => [c.id, c]));

  // Las noches, un contexto de club por club.
  const desde = new Date(Date.now() - 6 * 3600 * 1000);
  const idPorEvento = new Map(elegidos.map((e) => [e.eventId, e.id]));

  const noches = (
    await Promise.all(
      [...new Set(elegidos.map((e) => e.clubId))].map((clubId) =>
        withPublicClubRls(clubId, (tx) =>
          tx.event.findMany({
            where: {
              clubId,
              id: { in: elegidos.filter((e) => e.clubId === clubId).map((e) => e.eventId) },
              startsAt: { gte: desde },
            },
            orderBy: { startsAt: "asc" },
            take: 6,
            select: {
              id: true,
              name: true,
              clubId: true,
              startsAt: true,
              ticketTypes: {
                select: { status: true, prices: { where: { isCurrent: true }, select: { amountCents: true } } },
              },
            },
          }),
        ),
      ),
    )
  ).flat();

  const subscription = await getSubscriptionState("PROMOTER", promoter.id);
  const plan = subscription ? planByCode(subscription.planCode) : null;
  // Beta cerrada: el asistente está incluido, así que el panel no puede
  // decir "Off" ni ofrecerle planes que todavía no existen. El interruptor
  // es el mismo que usa el endpoint público (packages/core/billing.ts): si
  // uno dice que responde, el otro no puede decir que no.
  const aiEnabled = assistantAvailable(subscription);
  const ofrecerPlanes = !BETA_CERRADA;

  const now = Date.now();

  // Se recompone con la forma que tenía el `include` para que el JSX de
  // abajo no cambie por un arreglo que es de acceso a datos.
  const upcoming = noches
    .flatMap((event) => {
      const club = clubById.get(event.clubId);
      const id = idPorEvento.get(event.id);
      if (!club || !id) return [];
      return [{ id, event: { ...event, club } }];
    })
    .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())
    .slice(0, 6);

  const conClub = altas.flatMap((a) => {
    const club = clubById.get(a.clubId);
    return club ? [{ ...a, club }] : [];
  });
  const approved = conClub.filter((c) => c.status === "APPROVED");
  const pending = conClub.filter((c) => c.status === "PENDING");

  const trialDaysLeft =
    subscription?.status === "TRIALING" && subscription.trialEndsAt
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - now) / 86_400_000))
      : null;

  const completion = promoterCompletion({
    photoUrl: promoter.photoUrl,
    coverImageUrl: promoter.coverImageUrl,
    bio: promoter.bio,
    city: promoter.city,
    instagram: promoter.instagram,
    fourvenuesUrl: promoter.fourvenuesUrl,
    approvedClubCount: approved.length,
    selectedEventCount: elegidos.length,
  });

  const status = [
    {
      label: "Perfil público",
      value: "Activo",
      tone: "live" as const,
      href: `/${promoter.slug}`,
      external: true,
    },
    {
      label: "Fourvenues",
      value: promoter.fourvenuesUrl ? "Conectado" : "Sin configurar",
      tone: promoter.fourvenuesUrl ? ("live" as const) : ("warn" as const),
      href: "/promoter/integrations",
      external: false,
    },
    {
      label: "Asistente",
      value: aiEnabled ? "Activo" : "Desactivado",
      tone: aiEnabled ? ("live" as const) : ("warn" as const),
      href: "/promoter/assistant",
      external: false,
    },
    {
      label: "Discotecas",
      value: String(approved.length),
      tone: approved.length > 0 ? ("live" as const) : ("warn" as const),
      href: "/promoter/clubs",
      external: false,
    },
  ];

  return (
    <Page>
      <header className="nl-enter mb-6">
        <p className="nl-eyebrow">{greeting(new Date().getHours())}</p>
        <h1 className="nl-display nl-h2 mt-1.5">{promoter.displayName}</h1>
        <p className="nl-muted mt-1.5 text-[0.9375rem]">
          Tus noches. Tus enlaces. Tu asistente.
        </p>
      </header>

      <div className="nl-stagger grid gap-4">
        <ShareLink slug={promoter.slug} />

        <CompletionCard report={completion} />

        {pending.length > 0 ? (
          <p
            className="rounded-[var(--nl-r-md)] px-4 py-3 text-[0.875rem]"
            style={{ background: "var(--nl-warn-soft)", color: "var(--nl-warn)" }}
          >
            Pendiente de aprobación de {pending.map((p) => p.club.name).join(", ")}.
          </p>
        ) : null}

        {/* Estado de la herramienta, no de ninguna cuenta de resultados. */}
        <section className="grid grid-cols-2 gap-2">
          {status.map((item) =>
            item.external ? (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="nl-card nl-card--flat nl-card--interactive p-4"
              >
                <p className="nl-eyebrow">{item.label}</p>
                <p className="mt-1.5 flex items-center gap-2 font-semibold">
                  <Badge tone={item.tone} dot pulse={item.tone === "live"}>
                    {item.value}
                  </Badge>
                </p>
              </a>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                className="nl-card nl-card--flat nl-card--interactive p-4"
              >
                <p className="nl-eyebrow">{item.label}</p>
                <p className="mt-1.5 flex items-center gap-2 font-semibold">
                  <Badge tone={item.tone} dot pulse={item.tone === "live"}>
                    {item.value}
                  </Badge>
                </p>
              </Link>
            ),
          )}
        </section>

        {ofrecerPlanes && !isEntitled(subscription) ? (
          <div className="nl-card nl-card--flat p-4">
            <p className="font-semibold">Tu suscripción no está activa</p>
            <p className="nl-muted mt-1 text-[0.875rem]">
              Tu enlace sigue funcionando y enviando a la página de compra, pero el asistente no
              responderá por ti.
            </p>
            <div className="mt-3">
              <ButtonLink href="/promoter/subscription" variant="hot">
                Ver planes
              </ButtonLink>
            </div>
          </div>
        ) : ofrecerPlanes && !aiEnabled ? (
          <div className="nl-card nl-card--flat p-4">
            <p className="font-semibold">{plan?.name ?? "Tu plan"}</p>
            <p className="nl-muted mt-1 text-[0.875rem]">
              El asistente que responde por ti está incluido en Promoter Pro.
            </p>
            <div className="mt-3">
              <ButtonLink href="/promoter/subscription" variant="hot">
                Ver planes
              </ButtonLink>
            </div>
          </div>
        ) : trialDaysLeft !== null ? (
          <p className="nl-dim text-[0.8125rem]">
            {plan?.name ?? "Tu plan"}: quedan {trialDaysLeft} {trialDaysLeft === 1 ? "día" : "días"} de prueba.
          </p>
        ) : null}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="nl-eyebrow">Próximas noches</p>
            <ButtonLink href="/promoter/events" variant="ghost">
              Elegir
            </ButtonLink>
          </div>

          {upcoming.length === 0 ? (
            <EmptyState
              glyph={<Icon name="calendar" size={26} />}
              title="Aún no hay noches"
              body={
                approved.length === 0
                  ? "Los eventos vienen de las discotecas con las que trabajas. Cuando una te apruebe, sus noches aparecerán aquí."
                  : "Elige los eventos de tus discotecas y aparecerán directamente en tu perfil público."
              }
              action={
                <ButtonLink href={approved.length === 0 ? "/promoter/clubs" : "/promoter/events"} variant="hot">
                  {approved.length === 0 ? "Ver mis discotecas" : "Elegir eventos"}
                </ButtonLink>
              }
            />
          ) : (
            <ul className="grid gap-2">
              {upcoming.map((pe) => {
                // Precio de la entrada para el cliente. No es dinero del promoter.
                const cents = pe.event.ticketTypes
                  .filter((t) => t.status === "AVAILABLE")
                  .flatMap((t) => t.prices.map((p) => p.amountCents))
                  .sort((a, b) => a - b)[0];
                return (
                  <li key={pe.id} className="nl-card nl-card--flat">
                    <div className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="nl-eyebrow" style={{ color: "var(--nl-hot-ink)" }}>
                          {nightWeekdayEs(pe.event.startsAt, pe.event.club.timezone)}{" "}
                          {formatEventWhen(pe.event.startsAt, pe.event.club.timezone)}
                        </p>
                        <p className="mt-1 truncate font-semibold">{pe.event.name}</p>
                        <p className="nl-dim truncate text-[0.8125rem]">{pe.event.club.name}</p>
                      </div>
                      <span className="nl-price nl-price--md flex-none">
                        {cents !== undefined ? formatMoney(money(cents)) : "—"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
}
