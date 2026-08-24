import Link from "next/link";
import { formatMoney, money } from "@nightlife/core/money";
import { readableInkOn } from "@nightlife/core/contrast";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";
import { Badge } from "@/components/ui";

/**
 * La tarjeta de evento. Es el producto entero condensado.
 *
 * El flyer manda: en nightlife la imagen es la mitad de la decisión de ir o no
 * ir, y una fila de tabla la tira a la basura. Todo lo demás va encima del
 * flyer sobre un degradado, no en una caja aparte.
 *
 * Dos usos con reglas distintas:
 *  · público  → el CTA abre Fourvenues y es lo único que importa
 *  · panel    → la tarjeta entera lleva al detalle del evento
 */

export interface EventCardData {
  id: string;
  name: string;
  startsAt: Date;
  imageUrl: string | null;
  djs: string[];
  currentPriceCents: number | null;
  soldOut: boolean;
  checkoutUrl: string | null;
  clubName?: string;
  /** Precio caducado: se enseña la tarjeta, pero sin afirmar el importe. */
  priceStale?: boolean;
}

function Flyer({ event }: { event: EventCardData }) {
  return (
    <div className="nl-event__flyer">
      {event.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagen alojada por el club o la fuente
        <img src={event.imageUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <div className="nl-flyer-fallback">
          <span>{event.name.slice(0, 2)}</span>
        </div>
      )}
      <div className="nl-event__veil" />
    </div>
  );
}

function PriceBlock({ event }: { event: EventCardData }) {
  if (event.soldOut) {
    return <span className="nl-price nl-price--md nl-dim">Agotado</span>;
  }
  if (event.currentPriceCents === null || event.priceStale) {
    // Nunca un precio inventado ni un hueco mudo: se dice lo que sabemos.
    return <span className="nl-price nl-price--md nl-muted">Ver precio</span>;
  }
  return <span className="nl-price nl-price--lg">{formatMoney(money(event.currentPriceCents))}</span>;
}

function Meta({ event, timezone }: { event: EventCardData; timezone: string }) {
  return (
    <>
      <div className="nl-event__top">
        <Badge tone={event.soldOut ? "crit" : "live"} dot pulse={!event.soldOut}>
          {event.soldOut ? "Agotado" : "A la venta"}
        </Badge>
        {event.clubName ? <Badge>{event.clubName}</Badge> : null}
      </div>

      <div className="nl-event__body">
        <div>
          <p className="nl-eyebrow" style={{ color: "var(--nl-hot-ink)" }}>
            {nightWeekdayEs(event.startsAt, timezone)} · {formatEventWhen(event.startsAt, timezone)}
          </p>
          <h3 className="nl-display mt-1.5 text-[1.4rem] leading-[1.05]">{event.name}</h3>
          {event.djs.length > 0 ? (
            <p className="nl-muted mt-1 truncate text-[0.8125rem]">{event.djs.join(" · ")}</p>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Versión pública: el botón de compra es el protagonista. */
export function EventCard({
  event,
  timezone,
  accentColor,
  radius,
}: {
  event: EventCardData;
  timezone: string;
  accentColor: string;
  radius: number;
}) {
  return (
    <article className="nl-card nl-event" style={{ borderRadius: radius }}>
      <Flyer event={event} />
      <Meta event={event} timezone={timezone} />

      <div className="flex items-center justify-between gap-3 p-[18px] pt-3">
        <PriceBlock event={event} />
        {event.checkoutUrl && !event.soldOut ? (
          <a
            href={event.checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="nl-btn nl-btn--hot"
            style={{
              background: accentColor,
              // El club elige su color; la tinta la calculamos para que el
              // botón se lea también con un acento claro.
              color: readableInkOn(accentColor),
              borderRadius: radius,
              boxShadow: "none",
            }}
          >
            Comprar
          </a>
        ) : null}
      </div>
    </article>
  );
}

/** Versión de panel: la tarjeta entera es el enlace al detalle. */
export function EventCardAdmin({
  event,
  timezone,
  href,
  syncLabel,
}: {
  event: EventCardData;
  timezone: string;
  href: string;
  syncLabel?: string;
}) {
  return (
    <Link href={href} className="nl-card nl-card--interactive nl-event">
      <Flyer event={event} />
      <Meta event={event} timezone={timezone} />

      <div className="flex items-center justify-between gap-3 p-[18px] pt-3">
        <PriceBlock event={event} />
        <span className="nl-dim text-[0.75rem]">{syncLabel ?? ""}</span>
      </div>
    </Link>
  );
}
