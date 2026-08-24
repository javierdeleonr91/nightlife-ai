"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, CheckMark, Icon } from "@/components/ui";

/**
 * Importar un evento: la primera impresión del producto.
 *
 * Es el momento en que un club decide si esto está hecho para él. Un
 * formulario con un spinner dice "software"; una secuencia que le va contando
 * qué está leyendo dice "esto sabe de lo mío".
 *
 * Regla que me impuse: **el teatro no miente**. Las etapas avanzan mientras la
 * petición está de verdad en vuelo y la última no se marca hasta que llega la
 * respuesta. Si la fuente contesta en 300 ms, se salta directo al preview: no
 * hay esperas artificiales para que "parezca que trabaja". Una animación que
 * finge trabajo es exactamente igual de barata que un spinner, solo que más
 * larga.
 */

const STAGES = [
  { key: "read", label: "Leyendo el evento" },
  { key: "releases", label: "Comprobando los tramos de venta" },
  { key: "price", label: "Buscando el precio de ahora" },
  { key: "check", label: "Verificando el enlace de compra" },
] as const;

interface Preview {
  name: string;
  startsAt: string | null;
  venue: string | null;
  imageUrl: string | null;
  djs: string[];
  ticketUrl: string | null;
  currentPrice: { formatted: string; amountCents: number; usableByBot: boolean } | null;
  nextPrice: string | null;
  availability: string;
  ticketTypes: { name: string; price: string | null; status: string }[];
  missingFields: string[];
  warnings: string[];
  sourceUrl: string;
}

type Phase = "input" | "loading" | "preview" | "saving" | "done";

export function ImportExperience({ clubId, clubSlug }: { clubId: string; clubSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [priceOverride, setPriceOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPhase("input");
    setPreview(null);
    setRaw(null);
    setUrl("");
    setPriceOverride("");
    setError(null);
    setStage(0);
  }, []);

  // Escape cierra, y el foco entra en el campo al abrir. Lo mínimo para que
  // un modal no sea una trampa con teclado.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "loading" && phase !== "saving") close();
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, phase, close]);

  async function startImport(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;

    setPhase("loading");
    setError(null);
    setStage(0);

    // Las etapas avanzan mientras la petición está en vuelo, y se detienen en
    // la penúltima. La última la cierra la respuesta real.
    const ticker = setInterval(() => {
      setStage((s) => Math.min(s + 1, STAGES.length - 2));
    }, 620);

    try {
      const response = await fetch("/api/v1/fourvenues/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clubId, url: url.trim() }),
      });
      const data = await response.json();
      clearInterval(ticker);

      if (!response.ok) {
        setError(data.error?.message ?? "No se ha podido leer el evento");
        setPhase("input");
        return;
      }

      setStage(STAGES.length);
      setPreview(data.preview);
      setRaw(data.raw);
      if (data.preview.currentPrice && !data.preview.currentPrice.usableByBot) {
        setPriceOverride(String(Math.round(data.preview.currentPrice.amountCents / 100)));
      }
      // Un respiro corto para que el último check se vea completarse. Es lo
      // único "de más" en todo el flujo, y son 380 ms.
      setTimeout(() => setPhase("preview"), 380);
    } catch {
      clearInterval(ticker);
      setError("No hemos podido conectar. Prueba otra vez.");
      setPhase("input");
    }
  }

  async function confirm() {
    setPhase("saving");
    setError(null);
    const cents = priceOverride.trim()
      ? Math.round(Number(priceOverride.replace(",", ".")) * 100)
      : undefined;

    try {
      const response = await fetch("/api/v1/fourvenues/import/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clubId,
          raw,
          overrides:
            cents !== undefined && Number.isFinite(cents) ? { currentPriceCents: cents } : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error?.message ?? "No se ha podido guardar");
        setPhase("preview");
        return;
      }
      setPhase("done");
      // Se enseña el éxito y se lleva al evento recién creado, que es donde
      // la persona quiere estar. No se la devuelve a una lista.
      setTimeout(() => {
        router.push(`/club/${clubSlug}/events/${data.eventId}`);
        router.refresh();
      }, 900);
    } catch {
      setError("No hemos podido guardar. Prueba otra vez.");
      setPhase("preview");
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="nl-btn nl-btn--hot">
        <Icon name="plus" size={18} />
        Importar evento
      </button>
    );
  }

  return (
    <div
      className="nl-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase !== "loading" && phase !== "saving") close();
      }}
    >
      <div
        ref={dialogRef}
        className="nl-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Importar evento desde Fourvenues"
      >
        <div className="nl-modal__grab" />

        {phase === "input" ? (
          <form onSubmit={startImport} className="grid gap-5 p-6 pt-5 sm:p-8">
            <header className="grid gap-2">
              <Badge tone="violet">Fourvenues</Badge>
              <h2 className="nl-display nl-h2">Pega el enlace</h2>
              <p className="nl-muted">
                Copia la URL pública del evento y nos ocupamos del resto: precio vigente, tramos de venta y
                enlace de compra.
              </p>
            </header>

            <div className="nl-field">
              <label className="nl-sr" htmlFor="fv-url">
                URL del evento en Fourvenues
              </label>
              <input
                ref={inputRef}
                id="fv-url"
                className="nl-input nl-input--mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://fourvenues.com/tu-club/events/…"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required
              />
              {error ? <p className="nl-error">{error}</p> : null}
              <p className="nl-hint">
                Solo leemos la página pública. Si la fuente no lo permite, podrás meter los datos a
                mano.
              </p>
            </div>

            <div className="flex gap-2">
              <button type="submit" className="nl-btn nl-btn--hot nl-btn--block">
                Importar
              </button>
              <button type="button" onClick={close} className="nl-btn nl-btn--ghost">
                Cancelar
              </button>
            </div>
          </form>
        ) : null}

        {phase === "loading" ? (
          <div className="grid gap-5 p-6 pt-5 sm:p-8">
            <header className="grid gap-2">
              <Badge tone="violet">Leyendo</Badge>
              <h2 className="nl-display nl-h2">Un momento</h2>
            </header>

            <div className="nl-progress" aria-hidden="true">
              <div
                className="nl-progress__bar"
                style={{ width: `${Math.round(((stage + 1) / STAGES.length) * 100)}%` }}
              />
            </div>

            <ul aria-live="polite" className="grid">
              {STAGES.map((s, i) => {
                const state = i < stage ? "done" : i === stage ? "active" : "idle";
                return (
                  <li key={s.key} className={`nl-stage ${state === "idle" ? "" : `nl-stage--${state}`}`}>
                    <span className="nl-stage__mark">
                      {state === "done" ? (
                        <CheckMark size={13} />
                      ) : state === "active" ? (
                        <span className="nl-spinner" />
                      ) : null}
                    </span>
                    <span className="text-[0.9375rem]">{s.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {phase === "preview" && preview ? (
          <div className="grid gap-5 pb-6 sm:pb-8">
            {/* El flyer arriba, a sangre. Lo primero que ve el club es su
                propio evento, no una ficha de datos. */}
            <div className="relative aspect-[16/10] overflow-hidden">
              {preview.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- imagen de la fuente
                <img
                  src={preview.imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  decoding="async"
                />
              ) : (
                <div className="nl-flyer-fallback">
                  <span>{preview.name.slice(0, 2)}</span>
                </div>
              )}
              <div className="nl-event__veil" />
              <div className="absolute inset-x-0 bottom-0 p-6">
                <p className="nl-eyebrow" style={{ color: "var(--nl-hot-ink)" }}>
                  {preview.startsAt
                    ? new Date(preview.startsAt).toLocaleDateString("es-ES", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })
                    : "Sin fecha"}
                  {preview.venue ? ` · ${preview.venue}` : ""}
                </p>
                <h2 className="nl-display mt-2 text-[1.75rem] leading-none">{preview.name}</h2>
              </div>
            </div>

            <div className="grid gap-5 px-6 sm:px-8">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="nl-eyebrow">Precio ahora</p>
                  <p className="nl-price nl-price--xl mt-1">
                    {preview.currentPrice?.formatted ?? "—"}
                  </p>
                </div>
                {preview.nextPrice ? (
                  <div className="text-right">
                    <p className="nl-eyebrow">Después sube a</p>
                    <p className="nl-price nl-price--md nl-muted mt-1">{preview.nextPrice}</p>
                  </div>
                ) : null}
              </div>

              {preview.ticketTypes.length > 0 ? (
                <ul className="grid gap-1.5">
                  {preview.ticketTypes.map((t, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-3 rounded-[var(--nl-r-md)] bg-[var(--nl-surface-2)] px-4 py-3"
                    >
                      <span className="truncate text-[0.9375rem]">{t.name}</span>
                      <span className="flex flex-none items-center gap-3">
                        <span className="nl-num text-[0.875rem]">{t.price ?? "—"}</span>
                        <Badge tone={t.status === "AVAILABLE" ? "live" : "neutral"}>
                          {t.status === "AVAILABLE"
                            ? "A la venta"
                            : t.status === "SOLD_OUT"
                              ? "Agotado"
                              : "?"}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {preview.warnings.map((warning, i) => (
                <p
                  key={i}
                  className="rounded-[var(--nl-r-md)] bg-[var(--nl-warn-soft)] px-4 py-3 text-[0.875rem]"
                  style={{ color: "var(--nl-warn)" }}
                >
                  {warning}
                </p>
              ))}

              {preview.currentPrice && !preview.currentPrice.usableByBot ? (
                <div className="nl-field">
                  <label className="nl-label" htmlFor="price-fix">
                    Confirma el precio actual
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      id="price-fix"
                      className="nl-input nl-input--mono w-28"
                      value={priceOverride}
                      onChange={(e) => setPriceOverride(e.target.value)}
                      inputMode="decimal"
                      placeholder="20"
                    />
                    <span className="nl-muted text-[1.25rem]">€</span>
                  </div>
                  <p className="nl-hint">
                    La fuente no deja claro qué release está activo. Hasta que lo confirmes, el
                    asistente no dirá el precio.
                  </p>
                </div>
              ) : null}

              {error ? <p className="nl-error">{error}</p> : null}

              <div className="flex gap-2">
                <button type="button" onClick={confirm} className="nl-btn nl-btn--hot nl-btn--block">
                  Confirmar y añadir
                </button>
                <button type="button" onClick={close} className="nl-btn nl-btn--ghost">
                  Descartar
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {phase === "saving" ? (
          <div className="grid gap-4 p-10 text-center">
            <span className="nl-spinner mx-auto" style={{ width: 22, height: 22 }} />
            <p className="nl-muted">Guardando el evento…</p>
          </div>
        ) : null}

        {phase === "done" ? (
          <div className="grid gap-4 p-12 text-center">
            <span className="nl-success__ring">
              <CheckMark size={34} />
            </span>
            <h2 className="nl-display text-[1.5rem]">Evento añadido</h2>
            <p className="nl-muted">Tu asistente ya puede venderlo.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
