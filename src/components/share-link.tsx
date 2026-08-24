"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";
import { useToast } from "@/components/toast";

/**
 * Tu perfil público (§1, §13).
 *
 * La confusión que arregla esta tarjeta: el promoter tiene **dos** enlaces y
 * antes los dos se llamaban «mi link».
 *
 *   · el de aquí — su página en esta plataforma, la que pega en la bio;
 *   · el de Fourvenues — con el que vende, y que vive en Integrations.
 *
 * Por eso esta tarjeta dice «Your public profile» y enseña el dominio entero,
 * no «/alex». Un promoter que ve `/alex` no sabe qué mandar por WhatsApp.
 *
 * Tres acciones, no una: ver, copiar y compartir. En móvil, compartir abre la
 * hoja nativa, que es donde ya están WhatsApp e Instagram; en escritorio esa
 * hoja no existe y copiar es lo que se quiere.
 */
export function ShareLink({ slug }: { slug: string }) {
  const toast = useToast();
  const [origin, setOrigin] = useState("");

  // El origen se lee tras montar: en el servidor no existe y renderizar un
  // dominio adivinado sería peor que enseñar la ruta.
  useEffect(() => setOrigin(window.location.origin), []);

  const url = origin ? `${origin}/${slug}` : `/${slug}`;
  const shown = origin ? url.replace(/^https?:\/\//, "") : `…/${slug}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.ok("Enlace copiado");
    } catch {
      toast.error("Couldn't copy — select the link and copy it by hand.");
    }
  }

  async function share() {
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: "Tickets", url });
        return;
      } catch {
        // Cancelado por la persona: se cae a copiar, sin ruido.
      }
    }
    await copy();
  }

  return (
    <div
      className="nl-card p-5"
      style={{
        background:
          "radial-gradient(120% 100% at 80% 0%, var(--nl-hot-soft), transparent 65%), var(--nl-surface-1)",
      }}
    >
      <p className="nl-eyebrow">Tu perfil público</p>
      <p className="nl-display mt-1.5 truncate text-[1.35rem] lowercase">{shown}</p>
      <p className="nl-hint mt-1">This is the link for your Instagram bio.</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <a
          href={`/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="nl-btn nl-btn--quiet nl-btn--block"
        >
          <Icon name="eye" size={18} />
          View
        </a>
        <button type="button" onClick={copy} className="nl-btn nl-btn--quiet nl-btn--block">
          <Icon name="copy" size={18} />
          Copiar
        </button>
        <button
          type="button"
          onClick={share}
          className="nl-btn nl-btn--hot nl-btn--block"
          aria-live="polite"
        >
          <Icon name="share" size={18} />
          Compartir
        </button>
      </div>
    </div>
  );
}
