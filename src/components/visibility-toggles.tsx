"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";

/**
 * Qué se enseña en el perfil público (§6).
 *
 * Guardan al instante, sin botón: son tres interruptores y obligar a pulsar
 * «guardar» después de moverlos sería un paso de más para nada.
 *
 * El de WhatsApp arranca apagado en la base de datos a propósito. Es el
 * teléfono personal de alguien; publicarlo por defecto es un error que no se
 * deshace, porque el número ya circuló.
 */

export interface VisibilityField {
  name: "showInstagram" | "showWhatsapp" | "showCity";
  label: string;
  hint?: string;
  value: boolean;
  /** Si el dato no está puesto, el interruptor no tiene sentido. */
  available: boolean;
}

export function VisibilityToggles({ fields }: { fields: VisibilityField[] }) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<Record<string, boolean>>(
    Object.fromEntries(fields.map((f) => [f.name, f.value])),
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(field: VisibilityField) {
    const next = !state[field.name];
    setState((s) => ({ ...s, [field.name]: next }));
    setBusy(field.name);
    try {
      const response = await fetch("/api/v1/promoters/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field.name]: next }),
      });
      if (!response.ok) {
        setState((s) => ({ ...s, [field.name]: !next }));
        toast.error("Couldn't save that. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setState((s) => ({ ...s, [field.name]: !next }));
      toast.error("Couldn't save that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="grid gap-1">
      {fields.map((field) => {
        const on = state[field.name] ?? false;
        return (
          <li key={field.name} className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <p className={field.available ? "" : "nl-dim"}>{field.label}</p>
              <p className="nl-hint">
                {field.available
                  ? (field.hint ?? (on ? "Visible en tu perfil" : "Oculto"))
                  : "Add it above and you can show it here."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={field.label}
              disabled={!field.available || busy === field.name}
              onClick={() => toggle(field)}
              className={`nl-switch ${on ? "is-on" : ""}`}
            >
              <span className="nl-switch__dot" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
