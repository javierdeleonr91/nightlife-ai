"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckMark, Icon } from "@/components/ui";

/**
 * Refrescar los datos del evento.
 *
 * El botón tiene tres estados y el de éxito dura poco a propósito: un check
 * que se queda fijo deja de significar "acaba de pasar". Vuelve a reposo solo,
 * sin que nadie tenga que cerrarlo.
 */
export function RefreshButton({ clubId, eventId }: { clubId: string; eventId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "done" | "error">("idle");

  function refresh() {
    setState("idle");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/fourvenues/events/${eventId}/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clubId }),
        });
        if (!response.ok) {
          setState("error");
          setTimeout(() => setState("idle"), 3200);
          return;
        }
        setState("done");
        router.refresh();
        setTimeout(() => setState("idle"), 2200);
      } catch {
        setState("error");
        setTimeout(() => setState("idle"), 3200);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={pending}
      className="nl-btn nl-btn--quiet"
      style={state === "done" ? { color: "var(--nl-live)" } : undefined}
      aria-live="polite"
    >
      {pending ? (
        <span className="nl-spinner" />
      ) : state === "done" ? (
        <CheckMark size={17} />
      ) : (
        <Icon name="refresh" size={17} />
      )}
      {pending ? "Actualizando" : state === "done" ? "Al día" : state === "error" ? "No se pudo" : "Actualizar"}
    </button>
  );
}
