import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, ButtonLink, Icon, Panel } from "@/components/ui";
import { JoinClub } from "@/components/join-club";

/**
 * Clubs del promoter (§26).
 *
 * Un promoter trabaja para varios clubs y cada uno decide si le deja. Aquí ve
 * el estado real de cada relación — aprobado, esperando, rechazado — sin
 * eufemismos: si un club no le ha aprobado, sus eventos no salen en su página
 * pública y tiene que saber por qué.
 */

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "live" | "warn" | "crit"; note: string }> = {
  APPROVED: {
    label: "Aprobado",
    tone: "live",
    note: "Sus eventos pueden aparecer en tu página.",
  },
  PENDING: {
    label: "Pendiente",
    tone: "warn",
    note: "La discoteca aún no ha respondido. Sus eventos permanecerán ocultos hasta que lo haga.",
  },
  REJECTED: {
    label: "No aprobado",
    tone: "crit",
    note: "Esta discoteca no está trabajando contigo ahora mismo.",
  },
};

export default async function PromoterClubsPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  // Con el RRPP fijado. `promoter_clubs` y `promoter_events` tienen desde la
  // migración 011 una política de dos caras: el club ve sus RRPPs y el RRPP
  // ve sus clubs. Sin ese contexto, esta pantalla saldría vacía.
  const promoterId = principal.promoterId;
  const [links, eventCounts] = await withOwnerRls({ type: "PROMOTER", promoterId }, (tx) =>
    Promise.all([
      tx.promoterClub.findMany({
        where: { promoterId },
        // `brand` sale del include a propósito: `brand_settings` se filtra
        // por club y aquí el contexto es el del RRPP, así que vendría siempre
        // vacío. Nadie lo pintaba, así que no se sustituye por nada.
        include: { club: { select: { id: true, name: true, city: true, slug: true } } },
        orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
      }),
      tx.promoterEvent.groupBy({
        by: ["clubId"],
        where: { promoterId },
        _count: { _all: true },
      }),
    ]),
  );


  const countByClub = new Map(eventCounts.map((row) => [row.clubId, row._count._all]));

  return (
    <Page>
      <PageHeader
        eyebrow="Con quién trabajas"
        title="Discotecas"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Discotecas" }]}
      />

      {links.length === 0 ? (
        // Vacío con salida: la pantalla dice qué hacer y trae el campo para
        // hacerlo, en vez de mandar a la persona a buscar dónde se hace.
        <JoinClub />
      ) : (
        <div className="nl-stagger grid gap-3">
          {links.map((link) => {
            const status = STATUS[link.status] ?? STATUS.PENDING!;
            const events = countByClub.get(link.club.id) ?? 0;
            return (
              <article key={link.id} className="nl-integration">
                <span className="nl-integration__logo" aria-hidden="true">
                  <Icon name="crown" size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{link.club.name}</p>
                  <p className="nl-dim text-[0.8125rem]">
                    {link.club.city}
                    {link.status === "APPROVED"
                      ? ` · ${events} ${events === 1 ? "evento" : "eventos"} en tu página`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-3">
                  <Badge tone={status.tone} dot>
                    {status.label}
                  </Badge>
                  {link.status === "APPROVED" ? (
                    <ButtonLink href={`/c/${link.club.slug}`} variant="quiet">
                      Abrir
                    </ButtonLink>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {links.length > 0 ? (
        <div className="mt-4">
          <JoinClub compact />
        </div>
      ) : null}

      <Panel className="mt-6">
        <p className="nl-eyebrow mb-2">Por qué una discoteca debe aprobarte</p>
        <p className="nl-muted text-[0.9375rem]">
          Sus eventos, sus precios y sus condiciones de acceso. La aprobación permite que el asistente
          responda en su nombre cuando alguien llegue a través de tu enlace.
        </p>
      </Panel>
    </Page>
  );
}
