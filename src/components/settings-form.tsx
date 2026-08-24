"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckMark } from "@/components/ui";
import { THEME_ACCENT } from "@/design/theme";

/**
 * Formulario de ajustes genérico.
 *
 * Doce pantallas de este producto son «unos cuantos campos y un botón de
 * guardar». Escribirlas doce veces garantiza que doce se comporten distinto
 * ante un error. Una sola, dirigida por datos, se comporta igual en todas.
 *
 * Tres detalles que no son estéticos:
 *  · El botón solo se habilita si algo cambió. Guardar sin cambios es una
 *    petición inútil y un «guardado» que no significa nada.
 *  · El estado de éxito caduca solo. Un check fijo deja de querer decir
 *    «acaba de pasar».
 *  · Los errores del servidor se muestran junto al formulario, no en un toast
 *    que desaparece antes de leerlo.
 */

export type FieldKind = "text" | "textarea" | "url" | "tel" | "number" | "color";

export interface FieldSpec {
  name: string;
  label: string;
  kind?: FieldKind;
  hint?: string;
  placeholder?: string;
  prefix?: string;
  mono?: boolean;
  /** Valor que enseña el selector de color cuando el campo está vacío. */
  fallback?: string;
  maxLength?: number;
  required?: boolean;
}

export function SettingsForm({
  action,
  method = "PATCH",
  fields,
  initial,
  submitLabel = "Guardar cambios",
  onSavedGoTo,
}: {
  action: string;
  method?: "PATCH" | "POST" | "PUT";
  fields: FieldSpec[];
  initial: Record<string, string | number | null | undefined>;
  submitLabel?: string;
  onSavedGoTo?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, initial[f.name] == null ? "" : String(initial[f.name])])),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = fields.some(
    (f) => values[f.name] !== (initial[f.name] == null ? "" : String(initial[f.name])),
  );

  function set(name: string, value: string) {
    setSaved(false);
    setValues((v) => ({ ...v, [name]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // Los campos vacíos se mandan como null: es la diferencia entre «no lo
    // he tocado» y «quiero borrarlo», y el servidor tiene que poder saberla.
    const payload: Record<string, string | number | null> = {};
    for (const field of fields) {
      const raw = (values[field.name] ?? "").trim();
      if (raw === "") {
        payload[field.name] = null;
      } else if (field.kind === "number") {
        const n = Number(raw);
        payload[field.name] = Number.isFinite(n) ? n : null;
      } else {
        payload[field.name] = raw;
      }
    }

    try {
      const response = await fetch(action, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error?.message ?? "No se han podido guardar los cambios.");
        return;
      }
      setSaved(true);
      router.refresh();
      if (onSavedGoTo) router.push(onSavedGoTo);
      setTimeout(() => setSaved(false), 2400);
    } catch {
      setError("Problema de conexión. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {fields.map((field) => {
        const id = `f-${field.name}`;
        const value = values[field.name] ?? "";
        return (
          <div key={field.name} className="nl-field">
            <label className="nl-label" htmlFor={id}>
              {field.label}
            </label>

            {field.kind === "textarea" ? (
              <textarea
                id={id}
                className="nl-input"
                rows={3}
                value={value}
                maxLength={field.maxLength ?? 280}
                required={field.required ?? false}
                placeholder={field.placeholder ?? ""}
                onChange={(e) => set(field.name, e.target.value)}
              />
            ) : field.kind === "color" ? (
              <div className="flex items-center gap-3">
                <input
                  id={id}
                  type="color"
                  className="h-11 w-14 cursor-pointer rounded-[var(--nl-r-sm)] bg-transparent p-0"
                  value={value || field.fallback || THEME_ACCENT}
                  onChange={(e) => set(field.name, e.target.value)}
                />
                <input
                  className="nl-input nl-input--mono w-32"
                  value={value}
                  onChange={(e) => set(field.name, e.target.value)}
                  aria-label={`${field.label} hexadecimal`}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {field.prefix ? <span className="nl-dim text-[1.0625rem]">{field.prefix}</span> : null}
                <input
                  id={id}
                  className={`nl-input ${field.mono ? "nl-input--mono" : ""}`}
                  value={value}
                  required={field.required ?? false}
                  maxLength={field.maxLength ?? 200}
                  placeholder={field.placeholder ?? ""}
                  inputMode={
                    field.kind === "number" ? "numeric" : field.kind === "tel" ? "tel" : undefined
                  }
                  type={field.kind === "url" ? "url" : "text"}
                  onChange={(e) => set(field.name, e.target.value)}
                />
              </div>
            )}

            {field.hint ? <p className="nl-hint">{field.hint}</p> : null}
          </div>
        );
      })}

      {error ? <p className="nl-error">{error}</p> : null}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={busy || !dirty}
          className="nl-btn nl-btn--hot"
          aria-live="polite"
        >
          {busy ? <span className="nl-spinner" /> : saved ? <CheckMark size={18} /> : null}
          {busy ? "Guardando…" : saved ? "Guardado" : submitLabel}
        </button>
        {!dirty && !saved ? <span className="nl-dim text-[0.8125rem]">Aún no hay cambios</span> : null}
      </div>
    </form>
  );
}
