"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useToast } from "@/components/toast";

/**
 * «Enviar feedback» y la etiqueta Beta.
 *
 * Un piloto sin un canal de vuelta es un piloto del que no te enteras. Esto
 * es lo más pequeño que funciona: cuatro tipos, un texto y la ruta desde la
 * que se envió — sin la ruta, la mitad del feedback empieza por «en la
 * pantalla esa de los eventos».
 *
 * La etiqueta Beta va aquí al lado a propósito: enseña que esto es un
 * piloto sin dar sensación de producto roto, y de paso el botón queda
 * donde alguien lo va a encontrar cuando algo le falle.
 */

const TIPOS = [
  { value: "ERROR", label: "Error" },
  { value: "SUGGESTION", label: "Sugerencia" },
  { value: "INTEGRATION", label: "Integración" },
  { value: "OTHER", label: "Otro" },
] as const;

type Kind = (typeof TIPOS)[number]["value"];

export function BetaFeedback({ clubId }: { clubId?: string | null }) {
  const [abierto, setAbierto] = useState(false);
  const [kind, setKind] = useState<Kind>("ERROR");
  const [mensaje, setMensaje] = useState("");
  const [enviando, setEnviando] = useState(false);
  const pathname = usePathname();
  const toast = useToast();

  async function enviar() {
    setEnviando(true);
    try {
      const res = await fetch("/api/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clubId, kind, message: mensaje, path: pathname }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.ok("Recibido. Gracias — esto es justo lo que necesitamos.");
      setAbierto(false);
      setMensaje("");
      setKind("ERROR");
    } catch {
      toast.error("No se ha podido enviar. Inténtalo en un momento.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className="nl-badge"
          title="Nightlife está en periodo de pruebas con clubs y RRPPs reales."
        >
          Beta
        </span>
        <button
          type="button"
          className="nl-btn nl-btn--ghost text-[0.78rem]"
          onClick={() => setAbierto(true)}
        >
          Enviar feedback
        </button>
      </div>

      {abierto ? (
        <div
          className="nl-scrim"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAbierto(false);
          }}
          onKeyDown={(e) => {
            // Que Escape cierre no es un adorno: un modal que no se puede
            // cerrar en móvil deja al tester atrapado en la pantalla.
            if (e.key === "Escape") setAbierto(false);
          }}
        >
          <div className="nl-modal p-5" role="dialog" aria-modal="true" aria-labelledby="fb-title">
            <div className="nl-modal__grab" aria-hidden="true" />
            <h2 id="fb-title" className="nl-h3">
              ¿Qué ha pasado?
            </h2>
            <p className="nl-muted mt-1 text-[0.82rem]">
              Cuéntalo como se lo contarías a un amigo. No hace falta que sea
              técnico.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              {TIPOS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`nl-chip ${kind === t.value ? "nl-chip--on" : ""}`}
                  aria-pressed={kind === t.value}
                  onClick={() => setKind(t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <label className="nl-sr" htmlFor="fb-msg">
              Mensaje
            </label>
            <textarea
              id="fb-msg"
              className="nl-input mt-3 min-h-[110px]"
              value={mensaje}
              onChange={(e) => setMensaje(e.target.value)}
              placeholder="Ej.: al subir la portada desde el móvil se queda cargando."
              autoFocus
            />

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="nl-btn" onClick={() => setAbierto(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="nl-btn nl-btn--primary"
                disabled={enviando || mensaje.trim().length < 3}
                onClick={() => void enviar()}
              >
                Enviar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
