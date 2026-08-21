import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RESERVED_SLUGS } from "@nightlife/core/slug";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { EventCard, type EventCardData } from "@/components/event-card";
import { ChatWidget } from "@/components/chat-widget";

/**
 * Personal Link — /alex
 *
 * Vive en la raíz porque es lo que se pega en una bio de Instagram y lo que
 * se manda por WhatsApp. A cambio, el espacio de nombres es global: la lista
 * de rutas reservadas se comprueba aquí y al registrar el slug.
 */

export const revalidate = 60;

interface Props {
  params: Promise<{ promoterSlug: string }>;
}

async function loadPromoter(slug: string) {
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return null;
  return prisma.promoter.findUnique({
    where: { slug },
    include: {
      clubs: { where: { status: "APPROVED" }, include: { club: { include: { brand: true } } } },
      events: {
        include: {
          event: {
            include: {
              club: true,
              ticketTypes: { include: { prices: { where: { isCurrent: true } } } },
            },
          },
        },
      },
    },
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { promoterSlug } = await params;
  const promoter = await loadPromoter(promoterSlug);
  if (!promoter) return { title: "No encontrado" };
  return {
    title: `${promoter.displayName} · Entradas`,
    description: promoter.bio ?? `Próximos eventos con ${promoter.displayName}.`,
  };
}

export default async function PromoterPage({ params }: Props) {
  const { promoterSlug } = await params;
  const promoter = await loadPromoter(promoterSlug);
  if (!promoter) notFound();

  const approvedClubIds = new Set(promoter.clubs.map((c) => c.clubId));
  const now = Date.now() - 6 * 3600 * 1000;

  // Solo eventos de clubs donde su alta está aprobada. Un club que retira la
  // aprobación desaparece de su escaparate inmediatamente.
  const events: EventCardData[] = promoter.events
    .filter((pe) => approvedClubIds.has(pe.event.clubId))
    .filter((pe) => pe.event.startsAt.getTime() >= now)
    .filter((pe) => pe.event.status === "ACTIVE" || pe.event.status === "SOLD_OUT")
    .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())
    .slice(0, 12)
    .map((pe) => {
      const event = pe.event;
      const available = event.ticketTypes
        .filter((t) => t.status === "AVAILABLE")
        .flatMap((t) => t.prices.map((p) => p.amountCents))
        .sort((a, b) => a - b);

      // El enlace lleva una etiqueta de origen para que el club la vea en SU
      // ticketera. Nosotros la escribimos y no la leemos nunca: no calculamos
      // ventas del promoter ni le liquidamos nada.
      let checkoutUrl = event.ticketUrl;
      if (checkoutUrl) {
        try {
          const url = new URL(checkoutUrl);
          url.searchParams.set("promoter", pe.referralTag ?? promoter.slug);
          checkoutUrl = url.toString();
        } catch {
          // URL no parseable: se deja tal cual antes que romper la compra.
        }
      }

      return {
        id: event.id,
        name: `${event.name} · ${event.club.name}`,
        startsAt: event.startsAt,
        imageUrl: event.imageUrl,
        djs: event.djLineup,
        currentPriceCents: available[0] ?? null,
        soldOut:
          event.status === "SOLD_OUT" ||
          (event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.status === "SOLD_OUT")),
        checkoutUrl,
      };
    });

  const primaryClub = promoter.clubs[0]?.club ?? null;
  const accent = primaryClub?.brand?.primaryColor ?? "#FF2D6F";

  return (
    <main className="min-h-dvh bg-[#0B0B10] px-4 pb-28 pt-10 text-[#F5F3F7]">
      <div className="mx-auto w-full max-w-lg space-y-8">
        <header className="space-y-3 text-center">
          {promoter.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- foto subida por el promoter
            <img
              src={promoter.photoUrl}
              alt={promoter.displayName}
              className="mx-auto h-24 w-24 rounded-full object-cover"
            />
          ) : null}
          <h1 className="text-3xl font-black uppercase tracking-tight">{promoter.displayName}</h1>
          <p className="text-sm opacity-60">
            {promoter.city ? `${promoter.city} · ` : ""}
            {promoter.clubs.map((c) => c.club.name).join(" · ")}
          </p>
          {promoter.bio ? <p className="text-sm opacity-75">{promoter.bio}</p> : null}
        </header>

        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-50">
            Próximos eventos
          </h2>
          {events.length === 0 ? (
            <p className="text-sm opacity-60">Ahora mismo no tengo eventos publicados.</p>
          ) : (
            events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                timezone={primaryClub?.timezone ?? "Europe/Madrid"}
                accentColor={accent}
                radius={12}
              />
            ))
          )}
        </section>

        <footer className="flex justify-center gap-4 text-sm">
          {promoter.whatsapp ? (
            <a
              href={`https://wa.me/${promoter.whatsapp.replace(/[^\d]/g, "")}`}
              className="underline underline-offset-4 opacity-70 hover:opacity-100"
            >
              WhatsApp
            </a>
          ) : null}
          {promoter.instagram ? (
            <a
              href={`https://instagram.com/${promoter.instagram.replace("@", "")}`}
              className="underline underline-offset-4 opacity-70 hover:opacity-100"
            >
              Instagram
            </a>
          ) : null}
        </footer>
      </div>

      {primaryClub?.botEnabled ? (
        <ChatWidget
          clubSlug={primaryClub.slug}
          promoterSlug={promoter.slug}
          accentColor={accent}
          greeting={`¡Hola! Soy el asistente de ${promoter.displayName}. ¿Qué necesitas?`}
        />
      ) : null}
    </main>
  );
}
