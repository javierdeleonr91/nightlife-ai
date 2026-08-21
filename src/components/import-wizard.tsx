"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Asistente de import: URL → previsualización → confirmación.
 *
 * El paso de confirmar existe porque leemos una fuente que no controlamos. Si
 * el parser se equivoca, aquí se ve y se corrige; sin este paso, el error
 * acabaría en boca del bot delante de un cliente.
 */

interface Preview {
  name: string;
  startsAt: string | null;
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

export function ImportWizard({ clubId, clubSlug }: { clubId: string; clubSlug: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [priceOverride, setPriceOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doImport(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/fourvenues/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clubId, url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "No se ha podido leer el evento");
      setPreview(data.preview);
      setRaw(data.raw);
      // Si el precio no es utilizable por el bot, se precarga el campo para
      // que la persona lo confirme en lugar de tener que descubrirlo.
      if (data.preview.currentPrice && !data.preview.currentPrice.usableByBot) {
        setPriceOverride(String(Math.round(data.preview.currentPrice.amountCents / 100)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const cents = priceOverride.trim() ? Math.round(Number(priceOverride.replace(",", ".")) * 100) : undefined;
      const response = await fetch("/api/v1/fourvenues/import/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clubId,
          raw,
          overrides: cents !== undefined && Number.isFinite(cents) ? { currentPriceCents: cents } : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "No se ha podido guardar");
      router.push(`/club/${clubSlug}/overview`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={doImport} className="space-y-3">
        <label htmlFor="fv-url" className="block text-sm font-medium">
          URL pública del evento en Fourvenues
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="fv-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://fourvenues.com/tu-club/events/summer-closing"
            className="min-w-64 flex-1 rounded-lg border border-dash-line bg-dash-surface px-3 py-2.5 text-sm"
            required
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-dash-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Leyendo…" : "Leer evento"}
          </button>
        </div>
        <p className="text-xs text-dash-muted">
          Solo leemos la página pública del evento. Si la fuente no lo permite, podrás introducir los
          datos a mano.
        </p>
      </form>

      {error ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm">{error}</p>
      ) : null}

      {preview ? (
        <section className="space-y-4 rounded-xl border border-dash-line bg-dash-surface p-5">
          <h2 className="text-lg font-bold">{preview.name}</h2>

          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-dash-muted">Fecha</dt>
              <dd>{preview.startsAt ? new Date(preview.startsAt).toLocaleString("es-ES") : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-dash-muted">Precio detectado</dt>
              <dd className="font-semibold">{preview.currentPrice?.formatted ?? "no detectado"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-dash-muted">Siguiente release</dt>
              <dd>{preview.nextPrice ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-dash-muted">Cartel</dt>
              <dd>{preview.djs.length > 0 ? preview.djs.join(", ") : "—"}</dd>
            </div>
          </dl>

          {preview.ticketTypes.length > 0 ? (
            <ul className="divide-y divide-dash-line rounded-lg border border-dash-line text-sm">
              {preview.ticketTypes.map((t, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-2">
                  <span>{t.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{t.price ?? "—"}</span>
                    <span
                      className={
                        t.status === "AVAILABLE"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-dash-muted"
                      }
                    >
                      {t.status === "AVAILABLE" ? "a la venta" : t.status === "SOLD_OUT" ? "agotado" : "?"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {preview.warnings.map((warning, i) => (
            <p key={i} className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
              {warning}
            </p>
          ))}

          {preview.currentPrice && !preview.currentPrice.usableByBot ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
              El bot <strong>no dirá</strong> este precio hasta que lo confirmes tú: la fuente no deja
              claro qué release está activo.
            </p>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="price" className="block text-sm font-medium">
              Precio actual en euros {preview.currentPrice?.usableByBot ? "(opcional, para corregirlo)" : "(recomendado)"}
            </label>
            <input
              id="price"
              value={priceOverride}
              onChange={(e) => setPriceOverride(e.target.value)}
              inputMode="decimal"
              placeholder="20"
              className="w-32 rounded-lg border border-dash-line bg-dash-bg px-3 py-2 text-sm tabular-nums"
            />
            <p className="text-xs text-dash-muted">
              Lo que escribas aquí queda marcado como manual y la sincronización automática no lo
              sobrescribirá.
            </p>
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className="rounded-lg bg-dash-accent px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirmar evento
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-lg border border-dash-line px-4 py-2.5 text-sm"
            >
              Cancelar
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
