"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckMark, Icon } from "@/components/ui";
import { useToast } from "@/components/toast";

/**
 * «Add your Fourvenues sales link» (§14).
 *
 * Card con estado real, no un campo suelto perdido en un formulario. El RRPP
 * tiene que poder mirar esta pantalla y saber en dos segundos si está vendiendo
 * con su enlace o con el del club.
 *
 * Validación en el propio campo mientras escribe (§42): decirle al enviar que
 * la URL no vale, después de que la haya pegado y pulsado, es tarde.
 */

function looksLikeFourvenues(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "fourvenues.com" || host.endsWith(".fourvenues.com");
  } catch {
    return false;
  }
}

export function PromoterFourvenuesLink({ initial }: { initial: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);

  const connected = Boolean(initial);
  const touched = value.trim().length > 0;
  const valid = touched && looksLikeFourvenues(value);
  const problem = touched && !valid;

  async function save(next: string | null) {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/promoters/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fourvenuesUrl: next }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        toast.error(data?.error?.message ?? "No hemos podido guardar tu enlace. Inténtalo de nuevo.");
        return;
      }
      toast.ok(next ? "Enlace de Fourvenues guardado" : "Enlace de Fourvenues eliminado");
      setEditing(false);
      router.refresh();
    } catch {
      toast.error("No hemos podido guardar tu enlace. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  if (connected && !editing) {
    // Conectado: se enseña el dominio y el final del enlace, no el enlace
    // entero, porque suele ser larguísimo y no aporta nada verlo completo.
    let shown = initial as string;
    try {
      const url = new URL(shown);
      shown = `${url.hostname}${url.pathname.length > 24 ? `${url.pathname.slice(0, 24)}…` : url.pathname}`;
    } catch {
      /* si no parsea, se enseña tal cual */
    }

    return (
      <div className="nl-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="nl-eyebrow">Fourvenues · Enlace de ventas</p>
            <p className="nl-display mt-1 text-[1.15rem]">Conectado</p>
            <p className="nl-dim nl-num mt-1 truncate text-[0.8125rem]">{shown}</p>
          </div>
          <span style={{ color: "var(--nl-live)" }}>
            <CheckMark size={26} />
          </span>
        </div>

        <p className="nl-hint mt-4">
          Las personas que compren desde tu perfil público utilizarán este enlace exactamente como Fourvenues te lo dio,
          sin añadir ni modificar nada.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <a href={initial as string} target="_blank" rel="noopener noreferrer" className="nl-btn nl-btn--quiet">
            <Icon name="link" size={17} />
            Abrir enlace
          </a>
          <button type="button" onClick={() => setEditing(true)} className="nl-btn nl-btn--ghost">
            Cambiar
          </button>
          <button
            type="button"
            onClick={() => save(null)}
            disabled={busy}
            className="nl-btn nl-btn--ghost"
          >
            Eliminar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="nl-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="nl-eyebrow">Fourvenues · Enlace de ventas</p>
          <p className="nl-display mt-1 text-[1.35rem]">
            {connected ? "Cambiar tu enlace" : "Añadir tu enlace de ventas de Fourvenues"}
          </p>
        </div>
        {connected ? null : <span className="nl-badge nl-badge--warn">Sin configurar</span>}
      </div>

      <p className="nl-muted mt-3 text-[0.9375rem]">
        Pega el enlace personal de Fourvenues que ya utilizas para vender entradas. Lo utilizaremos exactamente como
        está, sin añadirle nada.
      </p>

      <div className="nl-field mt-5">
        <label className="nl-label" htmlFor="fv-link">
          Enlace de Fourvenues
        </label>
        <input
          id="fv-link"
          className="nl-input nl-input--mono"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://www.fourvenues.com/..."
          aria-invalid={problem}
        />
        {problem ? (
          <p className="nl-error">No parece un enlace válido de Fourvenues. Compruébalo y pega el enlace completo.</p>
        ) : (
          <p className="nl-hint">
            Si lo dejas vacío, los compradores irán al enlace oficial de la discoteca.
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => save(value.trim())}
          disabled={!valid || busy}
          className="nl-btn nl-btn--hot"
        >
          {busy ? <span className="nl-spinner" /> : null}
          {busy ? "Guardando…" : "Conectar"}
        </button>
        {connected ? (
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setValue(initial ?? "");
            }}
            className="nl-btn nl-btn--ghost"
          >
            Cancelar
          </button>
        ) : null}
      </div>
    </div>
  );
}
