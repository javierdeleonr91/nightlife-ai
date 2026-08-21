import { formatMoney, money } from "@nightlife/core/money";
import { formatEventWhen, nightWeekdayEs } from "@nightlife/core/time";

/**
 * La tarjeta de evento. Es el producto entero condensado: qué, cuándo,
 * cuánto ahora y COMPRAR. Nada más, y el botón siempre visible sin scroll
 * adicional.
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
}

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
    <article
      className="overflow-hidden border border-white/10 bg-white/[0.04]"
      style={{ borderRadius: radius }}
    >
      {event.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagen de dominio externo del club
        <img
          src={event.imageUrl}
          alt=""
          loading="lazy"
          className="aspect-[16/9] w-full object-cover"
        />
      ) : null}

      <div className="space-y-3 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-60">
          {nightWeekdayEs(event.startsAt, timezone)} · {formatEventWhen(event.startsAt, timezone)}
        </p>

        <h3 className="text-xl font-bold leading-tight">{event.name}</h3>

        {event.djs.length > 0 ? <p className="text-sm opacity-70">{event.djs.join(" · ")}</p> : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-2xl font-bold tabular-nums">
            {event.soldOut
              ? "Agotado"
              : event.currentPriceCents !== null
                ? formatMoney(money(event.currentPriceCents))
                : "Consultar"}
          </span>

          {event.checkoutUrl && !event.soldOut ? (
            <a
              href={event.checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-5 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90"
              style={{ background: accentColor, borderRadius: radius }}
            >
              COMPRAR ENTRADA
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
