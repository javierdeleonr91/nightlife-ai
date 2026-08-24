"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckMark } from "@/components/ui";

interface EventRow {
  id: string;
  name: string;
  clubName: string;
  when: string;
  price: string;
  imageUrl: string | null;
}

/**
 * Selección de eventos del promoter.
 *
 * Con flyer y toque grande: se usa con el pulgar. La fila entera es el área
 * táctil, no una casilla de 16px, y el estado seleccionado se ve por el propio
 * marco de la tarjeta en vez de por un checkbox del sistema.
 */
export function EventSelector({
  events,
  initialSelected,
}: {
  events: EventRow[];
  initialSelected: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSaved(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/v1/promoters/me/events", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventIds: [...selected] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(data?.error?.message ?? "No se ha podido guardar");
        return;
      }
      setSaved(true);
      router.refresh();
      setTimeout(() => setSaved(false), 2400);
    });
  }

  return (
    <div className="grid gap-4">
      <ul className="nl-stagger grid gap-2">
        {events.map((event) => {
          const on = selected.has(event.id);
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => toggle(event.id)}
                aria-pressed={on}
                className="nl-card nl-card--interactive w-full text-left"
                style={on ? { boxShadow: "var(--nl-glow-hot)" } : undefined}
              >
                <span className="flex items-center gap-3 p-3">
                  <span className="relative h-16 w-16 flex-none overflow-hidden rounded-[var(--nl-r-sm)]">
                    {event.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- imagen del club */
                      <img src={event.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="nl-flyer-fallback">
                        <span style={{ fontSize: "1.5rem" }}>{event.name.slice(0, 2)}</span>
                      </span>
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="nl-eyebrow block" style={{ color: "var(--nl-hot-ink)" }}>
                      {event.when}
                    </span>
                    <span className="mt-0.5 block truncate font-semibold">{event.name}</span>
                    <span className="nl-dim block truncate text-[0.8125rem]">{event.clubName}</span>
                  </span>

                  <span className="flex flex-none items-center gap-3">
                    <span className="nl-num text-[0.875rem]">{event.price}</span>
                    <span
                      className="grid h-6 w-6 place-items-center rounded-full"
                      style={{
                        background: on ? "var(--nl-hot)" : "var(--nl-surface-3)",
                        color: "#fff",
                      }}
                      aria-hidden="true"
                    >
                      {on ? <CheckMark size={14} /> : null}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {error ? <p className="nl-error">{error}</p> : null}

      {/* Barra fija: la selección se guarda sin tener que buscar el botón
          al final de una lista larga. */}
      <div className="sticky bottom-[104px] lg:bottom-6">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="nl-btn nl-btn--hot nl-btn--block nl-btn--lg"
          aria-live="polite"
        >
          {pending ? <span className="nl-spinner" /> : saved ? <CheckMark size={19} /> : null}
          {pending ? "Guardando" : saved ? "Guardado" : `Guardar (${selected.size})`}
        </button>
      </div>
    </div>
  );
}
