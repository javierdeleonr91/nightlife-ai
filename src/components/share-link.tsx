"use client";

import { useState } from "react";

/**
 * Compartir el link personal. Es la acción que más veces hará un promoter,
 * así que ocupa el sitio bueno y funciona de un toque. Web Share API en el
 * móvil, copiar al portapapeles en escritorio.
 */
export function ShareLink({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined" ? `${window.location.origin}/${slug}` : `/${slug}`;

  async function share() {
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: "Entradas", url });
        return;
      } catch {
        // El usuario canceló: se cae a copiar, sin ruido.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-xl border border-dash-line bg-dash-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dash-muted">Mi link</p>
      <p className="mt-1 truncate font-mono text-sm">/{slug}</p>
      <button
        type="button"
        onClick={share}
        className="mt-3 w-full rounded-lg bg-dash-accent px-4 py-3 text-sm font-bold text-white"
      >
        {copied ? "Copiado" : "Compartir"}
      </button>
    </div>
  );
}
