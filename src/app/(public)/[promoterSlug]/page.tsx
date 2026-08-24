import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { RESERVED_SLUGS } from "@nightlife/core/slug";
import { resolveCheckoutUrl } from "@nightlife/core/checkout";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls, withPublicClubRls } from "@nightlife/db/owner";
import { EventCard, type EventCardData } from "@/components/event-card";
import { ChatWidget } from "@/components/chat-widget";
import { THEME_ACCENT } from "@/design/theme";

/**
 * Perfil público del promoter — /alex  (§10, §11, §12, §52)
 *
 * Vive en la raíz porque es lo que se pega en una bio de Instagram. A cambio,
 * el espacio de nombres es global: la lista de rutas reservadas se comprueba
 * aquí y al registrar el slug.
 *
 * Antes era una columna de texto centrada y, sin eventos, una frase en medio
 * de una pantalla vacía. Ahora es un escaparate: portada a sangre, avatar
 * montado sobre el borde, nombre en grande y las noches como tarjetas con
 * flyer. Sin eventos sigue habiendo página — portada, quién es, dónde
 * encontrarle — porque un perfil vacío no es un fallo, es «todavía no hay
 * nada», y son cosas distintas.
 *
 * Lo que se enseña de sus datos lo decide él (§6). Un WhatsApp con el
 * interruptor apagado no sale, aunque esté guardado.
 */

export const revalidate = 60;

interface Props {
  params: Promise<{ promoterSlug: string }>;
}

/** Margen de cortesía: una noche sigue en cartel hasta 6 h después de abrir. */
const GRACIA_MS = 6 * 3600 * 1000;

/**
 * El perfil del RRPP, en tres contextos distintos y a propósito.
 *
 * ── Por qué no un solo `findUnique` con `include` ────────────────────
 * Como en el perfil del club, la raíz (`promoters`) no está bajo RLS pero
 * casi todo lo que cuelga de ella sí: `promoter_clubs`, `promoter_events`,
 * `brand_settings`, `events`, `ticket_types`, `ticket_prices`. Con `nl_app`
 * esas relaciones anidadas vuelven vacías sin dar error, así que el perfil
 * saldría publicado pero sin clubs, sin eventos y sin acento de marca.
 *
 * ── Los tres contextos ───────────────────────────────────────────────
 *
 *  1. **Global** — `promoters` y `clubs`. Ninguna de las dos está bajo RLS:
 *     son las tablas que resuelven identidades públicas y tienen que poder
 *     leerse antes de fijar nada.
 *
 *  2. **PROMOTER** — `promoter_clubs` y `promoter_events`. Son SUYAS. La
 *     política de dos caras de la migración 011 las hace visibles desde
 *     `app.current_promoter_id`, que es justo lo que hace falta aquí: un
 *     RRPP trabaja con varios clubs y no puede fijar uno solo para
 *     enumerarlos.
 *
 *  3. **CLUB, uno por club aprobado** — la marca y los eventos de cada
 *     club. Una transacción por club y no una sola con `clubId: { in: [...] }`
 *     porque el contexto de RLS es UN club: no existe una variable que
 *     signifique «estos tres». Mismo patrón que en /promoter/events.
 *
 * La autorización sale exclusivamente del paso 2: solo aparecen los clubs
 * cuya alta está APPROVED. Un club que retira la aprobación desaparece de
 * este escaparate en la siguiente revalidación. `contextClubId` no
 * interviene en nada de esto: no es autorización y aquí ni se menciona.
 *
 * `cache` porque `generateMetadata` y el componente llaman los dos a esto.
 */
const loadPromoter = cache(async (slug: string) => {
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return null;

  // ── 1. Global ────────────────────────────────────────────────────
  const promoter = await prisma.promoter.findUnique({ where: { slug } });
  if (!promoter) return null;

  const vacio = { ...promoter, clubs: [] as PromoterClubView[], events: [] as PromoterEventView[] };

  // ── 2. Contexto del RRPP ─────────────────────────────────────────
  const [altas, elegidos] = await withOwnerRls(
    { type: "PROMOTER", promoterId: promoter.id },
    (tx) =>
      Promise.all([
        tx.promoterClub.findMany({
          where: { promoterId: promoter.id, status: "APPROVED" },
          orderBy: { approvedAt: "asc" },
          select: { clubId: true },
        }),
        tx.promoterEvent.findMany({
          where: { promoterId: promoter.id },
          select: { eventId: true, clubId: true, checkoutUrl: true },
        }),
      ]),
  );

  const clubIds = altas.map((a) => a.clubId);
  if (clubIds.length === 0) return vacio;

  // ── 1 bis. Los clubs, otra vez global ────────────────────────────
  const clubRows = await prisma.club.findMany({ where: { id: { in: clubIds } } });
  const clubById = new Map(clubRows.map((c) => [c.id, c]));

  // ── 3. Un contexto de club por club ──────────────────────────────
  const desde = new Date(Date.now() - GRACIA_MS);

  const porClub = await Promise.all(
    clubIds.map((clubId) =>
      cargarCatalogo(
        clubId,
        elegidos.filter((e) => e.clubId === clubId).map((e) => e.eventId),
        desde,
      ),
    ),
  );

  // ── Recomposición ────────────────────────────────────────────────
  // Se devuelve con la misma forma que tenía el `include` de antes para que
  // el render no cambie ni una línea por este arreglo.
  const clubs: PromoterClubView[] = porClub.flatMap((bloque) => {
    const club = clubById.get(bloque.clubId);
    if (!club) return [];
    return [{ clubId: bloque.clubId, club: { ...club, brand: bloque.brand } }];
  });

  const checkoutPorEvento = new Map(elegidos.map((e) => [e.eventId, e.checkoutUrl]));

  const events: PromoterEventView[] = porClub
    .flatMap((bloque) => {
      const club = clubById.get(bloque.clubId);
      if (!club) return [];
      return bloque.events.map((event) => ({
        checkoutUrl: checkoutPorEvento.get(event.id) ?? null,
        event: { ...event, club },
      }));
    })
    .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())
    .slice(0, 12);

  return { ...promoter, clubs, events };
});

/**
 * La marca y las noches de UN club, en el contexto de ese club.
 *
 * Está fuera de `loadPromoter` por dos motivos, y el segundo importa más de
 * lo que parece:
 *
 *  1. Se llama una vez por club aprobado y así se lee de un vistazo.
 *  2. Los tipos de abajo se infieren de aquí. La alternativa —escribirlos a
 *     mano con `typeof prisma.brandSettings.findUnique`— mete literalmente
 *     el texto «prisma.brandSettings» y «prisma.event» en el archivo, y eso
 *     es exactamente lo que la guarda de tests/rls-readiness.test.ts busca
 *     para detectar lecturas sin contexto. Sería un uso de tipo, no una
 *     consulta, pero un guardarraíl que hay que explicar en cada excepción
 *     deja de ser un guardarraíl.
 */
function cargarCatalogo(clubId: string, eventIds: readonly string[], desde: Date) {
  return withPublicClubRls(clubId, (tx) =>
    Promise.all([
      tx.brandSettings.findUnique({ where: { clubId } }),
      tx.event.findMany({
        where: {
          clubId,
          id: { in: [...eventIds] },
          startsAt: { gte: desde },
          status: { in: ["ACTIVE", "SOLD_OUT"] },
        },
        orderBy: { startsAt: "asc" },
        take: 12,
        include: { ticketTypes: { include: { prices: { where: { isCurrent: true } } } } },
      }),
    ]).then(([brand, events]) => ({ clubId, brand, events })),
  );
}

type Catalogo = Awaited<ReturnType<typeof cargarCatalogo>>;
type ClubRow = Awaited<ReturnType<typeof prisma.club.findMany>>[number];

/**
 * La forma que tenía el `include` de antes, reconstruida a mano.
 *
 * Se conserva a propósito: así el render de abajo no cambia ni una línea
 * por un arreglo que es de acceso a datos, y la revisión de este parche se
 * puede centrar en las consultas.
 */
interface PromoterClubView {
  readonly clubId: string;
  readonly club: ClubRow & { readonly brand: Catalogo["brand"] };
}

interface PromoterEventView {
  readonly checkoutUrl: string | null;
  readonly event: Catalogo["events"][number] & { readonly club: ClubRow };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { promoterSlug } = await params;
  const promoter = await loadPromoter(promoterSlug);
  if (!promoter) return { title: "No encontrado" };
  return {
    title: `${promoter.displayName} · Entradas`,
    description: promoter.bio ?? `Próximos eventos con ${promoter.displayName}.`,
    openGraph: {
      title: promoter.displayName,
      description: promoter.bio ?? `Próximos eventos con ${promoter.displayName}.`,
      images: promoter.coverImageUrl ?? promoter.photoUrl ?? undefined,
    },
  };
}

export default async function PromoterPage({ params }: Props) {
  const { promoterSlug } = await params;
  const promoter = await loadPromoter(promoterSlug);
  if (!promoter) notFound();

  // Solo eventos de clubs donde su alta está aprobada. Un club que retira la
  // aprobación desaparece de su escaparate inmediatamente.
  //
  // El filtrado (alta aprobada, noche futura, estado publicable, orden y
  // tope de 12) ya lo hizo `loadPromoter`, y lo hizo en SQL y dentro del
  // contexto de RLS que toca. Antes estaba aquí en memoria sobre el
  // resultado de un `include` que traía TODOS los eventos del RRPP; ahora se
  // traen solo los que se pintan.
  const events: EventCardData[] = promoter.events
    .map((pe) => {
      const event = pe.event;
      const available = event.ticketTypes
        .filter((t) => t.status === "AVAILABLE")
        .flatMap((t) => t.prices.map((p) => p.amountCents))
        .sort((a, b) => a - b);

      // §50: si Fourvenues le dio al promoter su propia URL para este evento,
      // esa manda. Si no, la que él tenga configurada en su perfil. Si no, el
      // checkout oficial del club. Nunca componemos una.
      const { url: checkoutUrl } = resolveCheckoutUrl({
        clubCheckoutUrl: event.ticketUrl,
        promoterCheckoutUrl: pe.checkoutUrl ?? promoter.fourvenuesUrl,
      });

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
  const accent = primaryClub?.brand?.primaryColor ?? THEME_ACCENT;

  const initials = promoter.displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

  const instagram = promoter.showInstagram ? promoter.instagram : null;
  const whatsapp = promoter.showWhatsapp ? promoter.whatsapp : null;
  const city = promoter.showCity ? promoter.city : null;
  const clubNames = promoter.clubs.map((c) => c.club.name);

  return (
    <main className="min-h-dvh pb-32" style={{ background: "var(--nl-base)", color: "var(--nl-text)" }}>
      {/* ── portada ──────────────────────────────────────────────── */}
      <div className="nl-hero">
        {promoter.coverImageUrl ? (
          <Image
            src={promoter.coverImageUrl}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
        ) : (
          // Sin portada, un degradado con su acento. Nunca un rectángulo gris:
          // un hueco vacío arriba hunde la página entera.
          <div
            className="nl-hero__glow"
            style={{
              background: `radial-gradient(120% 120% at 50% 0%, ${accent}55, transparent 68%), linear-gradient(160deg, var(--nl-surface-2), var(--nl-base))`,
            }}
          />
        )}
        <div className="nl-hero__veil" />
      </div>

      <div className="mx-auto w-full max-w-xl px-5">
        {/* ── identidad ──────────────────────────────────────────── */}
        <header className="nl-enter">
          <div className="nl-hero-avatar" style={{ boxShadow: `0 0 0 4px var(--nl-base), 0 18px 44px -18px ${accent}` }}>
            {promoter.photoUrl ? (
              <Image src={promoter.photoUrl} alt={promoter.displayName} fill sizes="104px" className="object-cover" />
            ) : (
              initials
            )}
          </div>

          <h1 className="nl-display mt-4 text-[clamp(2rem,9vw,2.9rem)] leading-[1.02]">
            {promoter.displayName}
          </h1>

          {city || clubNames.length > 0 ? (
            <p className="nl-eyebrow mt-2.5">
              {[city, ...clubNames].filter(Boolean).join(" · ")}
            </p>
          ) : null}

          {promoter.bio ? <p className="nl-muted mt-3 text-balance">{promoter.bio}</p> : null}

          {instagram || whatsapp ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {instagram ? (
                <a
                  href={`https://instagram.com/${instagram.replace("@", "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nl-social"
                >
                  Instagram
                </a>
              ) : null}
              {whatsapp ? (
                <a
                  href={`https://wa.me/${whatsapp.replace(/[^\d]/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nl-social"
                >
                  WhatsApp
                </a>
              ) : null}
            </div>
          ) : null}
        </header>

        {/* ── noches ─────────────────────────────────────────────── */}
        <section className="mt-10">
          <p className="nl-eyebrow mb-4">
            {events.length > 0 ? "Próximas noches" : "Agenda"}
          </p>

          {events.length === 0 ? (
            // Vacío con intención (§12): la página sigue teniendo cara, dice
            // cuándo volver y deja una vía de contacto abierta.
            <div className="nl-card p-8 text-center">
              <p className="nl-display text-[1.5rem]">No hay noches publicadas</p>
              <p className="nl-muted mx-auto mt-2 max-w-[32ch] text-balance">
                Vuelve dentro de poco: la próxima aparece aquí en cuanto se anuncie.
              </p>
              {instagram ? (
                <div className="mt-5 flex justify-center">
                  <a
                    href={`https://instagram.com/${instagram.replace("@", "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="nl-btn nl-btn--quiet"
                  >
                    Sígueme en Instagram
                  </a>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="nl-stagger grid gap-5">
              {events.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  timezone={primaryClub?.timezone ?? "Europe/Madrid"}
                  accentColor={accent}
                  radius={22}
                />
              ))}
            </div>
          )}
        </section>
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
