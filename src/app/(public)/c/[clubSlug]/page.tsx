import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withPublicClubRls } from "@nightlife/db/owner";
import { EventCard, type EventCardData } from "@/components/event-card";
import { ChatWidget } from "@/components/chat-widget";

/**
 * Club Link — la página pública del club.
 *
 * Aquí la marca no es la nuestra: es la del club. El design system aporta la
 * forma (tarjetas, tipografía, ritmo) y el club pone el color, el logo y la
 * portada. Por eso esta página trabaja con estilos en línea derivados de sus
 * ajustes en lugar de con los tokens del panel.
 *
 * Prioridad absoluta: el botón de comprar siempre a un toque. Se revalida cada
 * 60 s para que el precio esté fresco y la página se sirva desde caché en el
 * pico del viernes.
 */

export const revalidate = 60;

interface Props {
  params: Promise<{ clubSlug: string }>;
}

/**
 * El club y todo lo que enseña su perfil, en dos pasos y no en uno.
 *
 * ── Por qué no un solo `findUnique` con `include` ────────────────────
 * `clubs` NO está bajo RLS —es la tabla que resuelve el slug, tiene que
 * poder leerse sin haber fijado ningún club todavía—, pero `brand_settings`,
 * `vip_options`, `events`, `ticket_types` y `ticket_prices` SÍ.
 *
 * Una relación anidada desde una raíz sin políticas hacia tablas con
 * políticas se ejecuta con `nl_app` sin error ninguno y vuelve **vacía**:
 * el club existiría, la página respondería 200, y se vería sin marca, sin
 * VIP y sin un solo evento. Consulta válida → cero filas → sin log. Es el
 * modo de fallo más caro que tiene RLS porque no se parece a un fallo.
 *
 * Así que: la raíz con el cliente global, y las cinco tablas de dentro en
 * una transacción con `app.current_club_id` fijado al club que acabamos de
 * resolver. Dentro de esa transacción `events → ticketTypes → prices` sí
 * puede ir anidado: las tres están bajo RLS y las tres llevan `clubId`, así
 * que la misma variable las cubre.
 *
 * El club llega como argumento resuelto en el servidor desde el slug de la
 * URL. No hay Principal —el visitante no ha iniciado sesión— y no se
 * fabrica uno.
 *
 * ── `cache` ──────────────────────────────────────────────────────────
 * `generateMetadata` y el componente llaman los dos a esto. Antes eran dos
 * consultas; ahora serían dos transacciones de tres consultas. `cache` de
 * React las deduplica dentro de la misma petición, así que el viernes por
 * la noche esto sigue costando lo mismo que costaba.
 */
const loadClub = cache(async (slug: string) => {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club) return null;

  const [brand, vipOptions, events] = await withPublicClubRls(club.id, (tx) =>
    Promise.all([
      tx.brandSettings.findUnique({ where: { clubId: club.id } }),
      tx.vIPOption.findMany({
        where: { clubId: club.id, isActive: true },
        orderBy: { sortOrder: "asc" },
      }),
      tx.event.findMany({
        where: {
          clubId: club.id,
          startsAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) },
          status: { in: ["ACTIVE", "SOLD_OUT"] },
        },
        orderBy: { startsAt: "asc" },
        take: 12,
        include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
      }),
    ]),
  );

  return { ...club, brand, vipOptions, events };
});

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
  const background = brand?.backgroundColor ?? "#0B0A10";
  const text = brand?.textColor ?? "#F5F2F8";
  const radius = brand?.borderRadius ?? 22;

  const events: EventCardData[] = club.events.map((event) => {
    const available = event.ticketTypes
      .filter((t) => t.status === "AVAILABLE")
      .flatMap((t) => t.prices.map((p) => p.amountCents))
      .sort((a, b) => a - b);
    return {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      imageUrl: event.imageUrl,
      djs: event.djLineup,
      currentPriceCents: available[0] ?? null,
      soldOut:
        event.status === "SOLD_OUT" ||
        (event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.status === "SOLD_OUT")),
      checkoutUrl: event.ticketUrl,
    };
  });

  return (
    <main
      className="min-h-dvh pb-32 pt-10"
      style={{
        background: `radial-gradient(90% 55% at 50% -5%, ${accent}22, transparent 70%), ${background}`,
        color: text,
        fontFamily: brand?.fontFamily
          ? `${brand.fontFamily}, var(--nl-ui)`
          : "var(--nl-ui)",
      }}
    >
      <div className="mx-auto w-full max-w-xl px-4">
        <header className="nl-enter mb-9 text-center">
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo alojado por el club
            <img
              src={brand.logoUrl}
              alt={club.name}
              className="mx-auto h-16 w-auto object-contain"
              decoding="async"
            />
          ) : (
            <h1 className="nl-display text-[clamp(2rem,10vw,3rem)]">{club.name}</h1>
          )}
          <p className="nl-eyebrow mt-3" style={{ color: `${text}88` }}>
            {club.city}
          </p>
        </header>

        <section className="nl-stagger grid gap-5">
          {events.length === 0 ? (
            <p className="py-10 text-center" style={{ color: `${text}99` }}>
              No hay eventos publicados ahora mismo.
            </p>
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
          <section className="mt-10">
            <p className="nl-eyebrow mb-3" style={{ color: `${text}88` }}>
              Reservados
            </p>
            <ul className="grid gap-2">
              {club.vipOptions.map((vip) => (
                <li
                  key={vip.id}
                  className="flex items-center justify-between gap-3 px-5 py-4"
                  style={{ borderRadius: radius, background: `${text}0D` }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{vip.name}</span>
                    <span className="text-[0.8125rem]" style={{ color: `${text}88` }}>
                      {vip.minPax}–{vip.maxPax} personas
                    </span>
                  </span>
                  <span className="nl-price nl-price--md flex-none">
                    {vip.priceCents !== null ? `${Math.round(vip.priceCents / 100)} €` : "Consultar"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer
          className="mt-12 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[0.875rem]"
          style={{ color: `${text}88` }}
        >
          {club.whatsapp ? (
            <a
              href={`https://wa.me/${club.whatsapp.replace(/[^\d]/g, "")}`}
              className="underline underline-offset-4"
            >
              WhatsApp
            </a>
          ) : null}
          {club.instagram ? (
            <a
              href={`https://instagram.com/${club.instagram.replace("@", "")}`}
              className="underline underline-offset-4"
            >
              Instagram
            </a>
          ) : null}
          {club.address ? <span>{club.address}</span> : null}
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
