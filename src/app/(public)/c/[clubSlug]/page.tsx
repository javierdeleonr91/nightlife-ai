import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { EventCard, type EventCardData } from "@/components/event-card";
import { ChatWidget } from "@/components/chat-widget";

/**
 * Club Link — la página pública del club.
 *
 * Mobile-first y con la compra siempre a un toque. Se revalida cada 60
 * segundos: suficiente para que el precio esté fresco y para que la página
 * se sirva desde caché en el pico del viernes noche.
 */

export const revalidate = 60;

interface Props {
  params: Promise<{ clubSlug: string }>;
}

async function loadClub(slug: string) {
  return prisma.club.findUnique({
    where: { slug },
    include: {
      brand: true,
      vipOptions: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
      events: {
        where: {
          startsAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) },
          status: { in: ["ACTIVE", "SOLD_OUT"] },
        },
        orderBy: { startsAt: "asc" },
        take: 12,
        include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
      },
    },
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clubSlug } = await params;
  const club = await loadClub(clubSlug);
  if (!club) return { title: "No encontrado" };
  return {
    title: `${club.name} · Entradas`,
    description: club.description ?? `Próximos eventos en ${club.name}, ${club.city}.`,
    openGraph: {
      title: club.name,
      images: club.brand?.coverImageUrl ? [club.brand.coverImageUrl] : [],
    },
  };
}

export default async function ClubPage({ params }: Props) {
  const { clubSlug } = await params;
  const club = await loadClub(clubSlug);
  if (!club || club.status !== "ACTIVE") notFound();

  const brand = club.brand;
  const accent = brand?.primaryColor ?? "#FF2D6F";
  const background = brand?.backgroundColor ?? "#0B0B10";
  const text = brand?.textColor ?? "#F5F3F7";
  const radius = brand?.borderRadius ?? 12;

  const events: EventCardData[] = club.events.map((event) => {
    const available = event.ticketTypes
      .filter((t) => t.status === "AVAILABLE")
      .flatMap((t) => t.prices.map((p) => p.amountCents))
      .sort((a, b) => a - b);
    const soldOut =
      event.status === "SOLD_OUT" ||
      (event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.status === "SOLD_OUT"));

    return {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      imageUrl: event.imageUrl,
      djs: event.djLineup,
      currentPriceCents: available[0] ?? null,
      soldOut,
      checkoutUrl: event.ticketUrl,
    };
  });

  return (
    // El branding se aplica por variables en línea: cada club parece tener su
    // propia página sin generar una hoja de estilos por tenant.
    <main
      className="min-h-dvh px-4 pb-28 pt-8"
      style={{ background, color: text, fontFamily: `${brand?.fontFamily ?? "Inter"}, system-ui, sans-serif` }}
    >
      <div className="mx-auto w-full max-w-lg space-y-8">
        <header className="space-y-3 text-center">
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo alojado por el club
            <img src={brand.logoUrl} alt={club.name} className="mx-auto h-16 w-auto object-contain" />
          ) : (
            <h1 className="text-3xl font-black uppercase tracking-tight">{club.name}</h1>
          )}
          <p className="text-sm opacity-60">{club.city}</p>
        </header>

        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-50">
            Próximos eventos
          </h2>
          {events.length === 0 ? (
            <p className="text-sm opacity-60">No hay eventos publicados ahora mismo.</p>
          ) : (
            events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                timezone={club.timezone}
                accentColor={accent}
                radius={radius}
              />
            ))
          )}
        </section>

        {club.vipOptions.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-50">Reservados</h2>
            <ul className="space-y-2">
              {club.vipOptions.map((vip) => (
                <li
                  key={vip.id}
                  className="flex items-center justify-between border border-white/10 bg-white/[0.04] px-4 py-3"
                  style={{ borderRadius: radius }}
                >
                  <span className="text-sm">
                    <strong className="font-semibold">{vip.name}</strong>
                    <span className="opacity-60"> · {vip.minPax}–{vip.maxPax} pax</span>
                  </span>
                  <span className="text-sm font-bold tabular-nums">
                    {vip.priceCents !== null ? `${Math.round(vip.priceCents / 100)} €` : "Consultar"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="flex flex-wrap justify-center gap-3 pt-2 text-sm">
          {club.whatsapp ? (
            <a
              href={`https://wa.me/${club.whatsapp.replace(/[^\d]/g, "")}`}
              className="underline underline-offset-4 opacity-70 hover:opacity-100"
            >
              WhatsApp
            </a>
          ) : null}
          {club.instagram ? (
            <a
              href={`https://instagram.com/${club.instagram.replace("@", "")}`}
              className="underline underline-offset-4 opacity-70 hover:opacity-100"
            >
              Instagram
            </a>
          ) : null}
          {club.address ? <span className="opacity-50">{club.address}</span> : null}
        </footer>
      </div>

      {club.botEnabled ? (
        <ChatWidget
          clubSlug={club.slug}
          accentColor={accent}
          greeting={`¡Hola! Soy el asistente de ${club.name}. ¿Qué quieres saber?`}
        />
      ) : null}
    </main>
  );
}
