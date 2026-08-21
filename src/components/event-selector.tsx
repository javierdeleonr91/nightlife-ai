"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface EventRow {
  id: string;
  name: string;
  clubName: string;
  when: string;
  price: string;
}

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
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
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
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-dash-line overflow-hidden rounded-xl border border-dash-line bg-dash-surface">
        {events.map((event) => (
          <li key={event.id}>
            <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                checked={selected.has(event.id)}
                onChange={() => toggle(event.id)}
                className="h-5 w-5 shrink-0 accent-[var(--dash-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{event.name}</span>
                <span className="block text-xs text-dash-muted">
                  {event.clubName} · {event.when}
                </span>
              </span>
              <span className="shrink-0 text-sm font-bold tabular-nums">{event.price}</span>
            </label>
          </li>
        ))}
      </ul>

      {error ? <p className="text-sm text-rose-500">{error}</p> : null}

      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="w-full rounded-lg bg-dash-accent px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
      >
        {pending ? "Guardando…" : `Guardar (${selected.size})`}
      </button>
    </div>
  );
}
