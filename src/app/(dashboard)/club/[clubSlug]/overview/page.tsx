import Link from "next/link";
import { notFound } from "next/navigation";
import { assertTenantAccess, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";

/**
 * Overview del club.
 *
 * Cuatro cifras y ninguna gráfica. La que importa es la última: las
 * conversaciones esperando a una persona. Es la que hace que alguien abra
 * este panel un sábado.
 */

export const dynamic = "force-dynamic";

export default async function OverviewPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({
    where: { slug: clubSlug },
    include: { aiConfig: true },
  });
  if (!club) notFound();
  assertTenantAccess(principal, club.id);

  const [activeEvents, waitingHuman, sources, lastLog] = await Promise.all([
    prisma.event.count({
      where: { clubId: club.id, status: "ACTIVE", startsAt: { gte: new Date() } },
    }),
    prisma.conversation.count({ where: { clubId: club.id, status: "WAITING_HUMAN" } }),
    prisma.eventSource.findMany({
      where: { clubId: club.id },
      orderBy: { lastSyncedAt: "desc" },
      take: 1,
    }),
    prisma.aiRequestLog.findFirst({ where: { clubId: club.id }, orderBy: { createdAt: "desc" } }),
  ]);

  const source = sources[0];
  const sourceHealthy = source?.syncStatus === "OK";

  const tiles = [
    {
      label: "Bot",
      value: club.botEnabled ? "Activo" : "Apagado",
      tone: club.botEnabled ? "ok" : "warn",
    },
    {
      label: "Fourvenues",
      value: !source ? "Sin conectar" : sourceHealthy ? "Sincronizado" : "Con errores",
      tone: !source ? "warn" : sourceHealthy ? "ok" : "crit",
    },
    { label: "Eventos activos", value: String(activeEvents), tone: activeEvents > 0 ? "ok" : "warn" },
    {
      label: "Esperando a una persona",
      value: String(waitingHuman),
      tone: waitingHuman > 0 ? "crit" : "ok",
    },
  ] as const;

  const toneClass: Record<string, string> = {
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    crit: "text-rose-600 dark:text-rose-400",
  };

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-5 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{club.name}</h1>
          <p className="text-sm text-dash-muted">{club.city}</p>
        </div>
        <Link
          href={`/c/${club.slug}`}
          className="rounded-lg border border-dash-line px-3 py-2 text-sm hover:bg-dash-surface"
        >
          Ver página pública →
        </Link>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-dash-line bg-dash-surface p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dash-muted">
              {tile.label}
            </p>
            <p className={`mt-1.5 text-2xl font-bold tabular-nums ${toneClass[tile.tone]}`}>
              {tile.value}
            </p>
          </div>
        ))}
      </section>

      {!club.botEnabled ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          El bot está apagado. Importa un evento y actívalo para que empiece a responder.
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dash-muted">
          Siguiente paso
        </h2>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/club/${club.slug}/events`}
            className="rounded-lg bg-dash-accent px-4 py-2.5 text-sm font-semibold text-white"
          >
            Importar evento
          </Link>
          <Link
            href={`/club/${club.slug}/conversations`}
            className="rounded-lg border border-dash-line px-4 py-2.5 text-sm font-semibold hover:bg-dash-surface"
          >
            Conversaciones {waitingHuman > 0 ? `(${waitingHuman})` : ""}
          </Link>
        </div>
      </section>

      {lastLog ? (
        <p className="text-xs text-dash-muted">
          Última respuesta del bot: {lastLog.resolvedBy.toLowerCase()} · {lastLog.latencyMs ?? 0} ms ·{" "}
          {lastLog.validationPassed === false ? "rechazada por el validador" : "validada"}
        </p>
      ) : null}
    </main>
  );
}
