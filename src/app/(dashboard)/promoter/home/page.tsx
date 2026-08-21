import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen } from "@nightlife/core/time";
import { hasFeature, isEntitled, planByCode } from "@nightlife/core/billing";
import { getSubscriptionState, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { ShareLink } from "@/components/share-link";

/**
 * Home del promoter. Mobile-first de verdad: se usa con una mano, de pie, en
 * la puerta de un club.
 *
 * NO hay panel de ventas, ni contador de entradas vendidas, ni comisiones, ni
 * saldo. El promoter es un cliente que paga por una herramienta, no un
 * afiliado al que liquidamos dinero: quien cobra las entradas es Fourvenues, y
 * cuánto ha vendido lo ve allí o se lo dice su club. Lo que le damos nosotros
 * es el escaparate y el asistente.
 *
 * Los precios que aparecen abajo son los de las entradas del club —lo que el
 * promoter necesita saber para responder— no ingresos suyos.
 */

export const dynamic = "force-dynamic";

export default async function PromoterHome() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const promoter = await prisma.promoter.findUnique({
    where: { id: principal.promoterId },
    include: {
      clubs: { include: { club: true } },
      events: {
        include: {
          event: {
            include: { club: true, ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
          },
        },
      },
    },
  });
  if (!promoter) redirect("/onboarding");

  const subscription = await getSubscriptionState("PROMOTER", promoter.id);
  const plan = subscription ? planByCode(subscription.planCode) : null;
  const aiEnabled = hasFeature(subscription, "ai_assistant");

  const now = Date.now();
  const upcoming = promoter.events
    .filter((pe) => pe.event.startsAt.getTime() >= now - 6 * 3600 * 1000)
    .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())
    .slice(0, 5);

  const approved = promoter.clubs.filter((c) => c.status === "APPROVED");
  const pending = promoter.clubs.filter((c) => c.status === "PENDING");

  const trialDaysLeft =
    subscription?.status === "TRIALING" && subscription.trialEndsAt
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - now) / 86_400_000))
      : null;

  return (
    <main className="mx-auto w-full max-w-md space-y-7 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">{promoter.displayName}</h1>
        <p className="text-sm text-dash-muted">
          {approved.map((c) => c.club.name).join(" · ") || "Sin clubs todavía"}
        </p>
      </header>

      <ShareLink slug={promoter.slug} />

      {pending.length > 0 ? (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          Pendiente de aprobación en {pending.map((p) => p.club.name).join(", ")}.
        </p>
      ) : null}

      {/* Estado del producto, no de ninguna cuenta de resultados. */}
      <section className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-dash-line bg-dash-surface p-3">
          <p className="text-[10px] uppercase tracking-wide text-dash-muted">Clubs</p>
          <p className="text-2xl font-bold tabular-nums">{approved.length}</p>
        </div>
        <div className="rounded-xl border border-dash-line bg-dash-surface p-3">
          <p className="text-[10px] uppercase tracking-wide text-dash-muted">Eventos</p>
          <p className="text-2xl font-bold tabular-nums">{upcoming.length}</p>
        </div>
        <div className="rounded-xl border border-dash-line bg-dash-surface p-3">
          <p className="text-[10px] uppercase tracking-wide text-dash-muted">Asistente</p>
          <p
            className={`text-sm font-bold ${
              aiEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {aiEnabled ? "Activo" : "Inactivo"}
          </p>
        </div>
      </section>

      {!isEntitled(subscription) ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm">
          <p className="font-semibold">Tu suscripción no está activa</p>
          <p className="text-dash-muted">
            Tu link sigue funcionando, pero el asistente no responde.{" "}
            <Link href="/promoter/subscription" className="underline underline-offset-4">
              Ver planes
            </Link>
          </p>
        </div>
      ) : !aiEnabled ? (
        <div className="rounded-xl border border-dash-line bg-dash-surface px-4 py-3 text-sm">
          <p className="font-semibold">Plan {plan?.name ?? "actual"}</p>
          <p className="text-dash-muted">
            El asistente que responde por ti está en Promoter Pro.{" "}
            <Link href="/promoter/subscription" className="underline underline-offset-4">
              Ver planes
            </Link>
          </p>
        </div>
      ) : trialDaysLeft !== null ? (
        <p className="text-xs text-dash-muted">
          Prueba de {plan?.name ?? "tu plan"}: te quedan {trialDaysLeft} día
          {trialDaysLeft === 1 ? "" : "s"}.{" "}
          <Link href="/promoter/subscription" className="underline underline-offset-4">
            Gestionar suscripción
          </Link>
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dash-muted">
          Mis próximos eventos
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-dash-muted">
            No tienes eventos seleccionados.{" "}
            <Link href="/promoter/events" className="underline underline-offset-4">
              Elegir eventos
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-dash-line overflow-hidden rounded-xl border border-dash-line bg-dash-surface">
            {upcoming.map((pe) => {
              // Precio de la entrada para el cliente. No es dinero del promoter.
              const cents = pe.event.ticketTypes
                .filter((t) => t.status === "AVAILABLE")
                .flatMap((t) => t.prices.map((p) => p.amountCents))
                .sort((a, b) => a - b)[0];
              return (
                <li key={pe.id} className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{pe.event.name}</p>
                    <p className="text-xs text-dash-muted">
                      {pe.event.club.name} · {formatEventWhen(pe.event.startsAt, pe.event.club.timezone)}
                    </p>
                  </div>
                  <span className="shrink-0 font-bold tabular-nums">
                    {cents !== undefined ? formatMoney(money(cents)) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <nav className="grid grid-cols-2 gap-2 text-sm">
        <Link
          href="/promoter/events"
          className="rounded-lg border border-dash-line bg-dash-surface px-4 py-3 text-center font-semibold"
        >
          Mis eventos
        </Link>
        <Link
          href="/promoter/subscription"
          className="rounded-lg border border-dash-line bg-dash-surface px-4 py-3 text-center font-semibold"
        >
          Suscripción
        </Link>
      </nav>
    </main>
  );
}
