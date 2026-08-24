"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckMark, Icon } from "@/components/ui";

/**
 * Avisos (§40).
 *
 * Un único sitio decide cómo se confirma que algo ha pasado. Antes cada
 * pantalla se lo inventaba: unas ponían un check dentro del botón, otras nada,
 * y guardar un perfil parecía no hacer nada.
 *
 * Tres decisiones que no son estéticas:
 *
 *  · Los avisos de éxito caducan solos; los de error **no**. Un error que se
 *    va antes de leerlo es peor que ningún error.
 *  · `role="status"` con `aria-live="polite"`: un lector de pantalla anuncia
 *    «Perfil actualizado» sin interrumpir lo que estuviera leyendo.
 *  · Se apilan abajo en móvil y abajo a la derecha en escritorio, lejos del
 *    pulgar y del contenido.
 */

export type ToastTone = "ok" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  ok(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    // Fallar aquí, en desarrollo, es mejor que un guardado silencioso en
    // producción porque alguien olvidó el provider.
    throw new Error("useToast necesita <ToastProvider> por encima.");
  }
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((list) => [...list.slice(-2), { id, tone, message }]);
      if (tone !== "error") {
        setTimeout(() => dismiss(id), 3200);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      ok: (message) => push("ok", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="nl-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`nl-toast nl-toast--${toast.tone}`}>
            <span className="nl-toast__mark" aria-hidden="true">
              {toast.tone === "ok" ? <CheckMark size={14} /> : <Icon name="bolt" size={15} />}
            </span>
            <span className="min-w-0 flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="nl-toast__close"
              aria-label="Dismiss"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
