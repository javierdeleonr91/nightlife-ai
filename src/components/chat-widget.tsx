"use client";

import { useEffect, useRef, useState } from "react";
import { readableInkOn } from "@nightlife/core/contrast";

/**
 * Webchat de la página pública.
 *
 * Se pinta con el color del club, no con el nuestro: aquí la marca es suya.
 * Por eso este componente no usa los tokens del design system para color —
 * usa el acento que recibe y transparencias sobre él.
 *
 * Sin localStorage: el token de conversación vive en memoria durante la
 * visita. Es lo correcto para RGPD y elimina la necesidad de banner de
 * cookies, que es justo lo que estorba a la conversión.
 */

interface Cta {
  label: string;
  url: string;
  kind: "BUY" | "VIP" | "WHATSAPP";
}

interface Turn {
  role: "customer" | "bot";
  text: string;
  cta?: Cta | null;
}

export function ChatWidget({
  clubSlug,
  promoterSlug,
  accentColor,
  greeting,
}: {
  clubSlug: string;
  promoterSlug?: string;
  accentColor: string;
  greeting: string;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([{ role: "bot", text: greeting }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // El club elige su acento; nosotros calculamos la tinta para que el texto
  // se lea también sobre un color claro. Es el botón que cierra la venta.
  const onAccent = readableInkOn(accentColor);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;

    setInput("");
    setTurns((t) => [...t, { role: "customer", text: message }]);
    setBusy(true);

    try {
      const response = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clubSlug, promoterSlug, message, chatToken: tokenRef.current ?? undefined }),
      });
      const data = (await response.json()) as {
        reply?: string | null;
        cta?: Cta | null;
        waitingHuman?: boolean;
        assistantUnavailable?: boolean;
        chatToken?: string | null;
        error?: { message: string };
      };

      if (data.chatToken) tokenRef.current = data.chatToken;

      if (data.error) {
        setTurns((t) => [...t, { role: "bot", text: data.error!.message }]);
      } else if (data.assistantUnavailable) {
        setTurns((t) => [
          ...t,
          { role: "bot", text: "Ahora mismo no puedo contestarte por aquí. Escríbeme por WhatsApp o Instagram 👋" },
        ]);
      } else if (data.reply) {
        setTurns((t) => [...t, { role: "bot", text: data.reply as string, cta: data.cta }]);
      } else if (data.waitingHuman) {
        setTurns((t) => [...t, { role: "bot", text: "Te contestan en un momento 👌" }]);
      }
    } catch {
      // Nunca dejamos al cliente sin respuesta, ni siquiera si falla la red.
      setTurns((t) => [...t, { role: "bot", text: "Se me ha ido la conexión. Prueba otra vez." }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="nl-btn fixed bottom-5 right-4 z-40 sm:right-6"
        style={{
          background: accentColor,
          color: onAccent,
          boxShadow: `0 10px 34px -10px ${accentColor}`,
        }}
      >
        <span
          className="nl-dot nl-dot--pulse"
          style={{ background: onAccent, opacity: 0.85 }}
          aria-hidden="true"
        />
        Pregunta lo que sea
      </button>
    );
  }

  return (
    <div
      className="fixed inset-x-3 bottom-3 z-40 flex max-h-[76dvh] flex-col overflow-hidden sm:inset-x-auto sm:right-6 sm:w-[380px]"
      style={{
        borderRadius: 24,
        background: "rgba(10, 9, 14, 0.86)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
        boxShadow: "0 32px 80px -32px rgba(0,0,0,1)",
        animation: "nl-sheet-in 480ms cubic-bezier(.16,1,.3,1)",
      }}
      role="dialog"
      aria-label="Chat"
    >
      <header className="flex items-center justify-between px-5 py-4">
        <span className="flex items-center gap-2 text-[0.9375rem] font-semibold text-white">
          <span className="nl-dot nl-dot--pulse" style={{ background: accentColor }} aria-hidden="true" />
          Asistente
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-white/50 transition-opacity hover:text-white"
          aria-label="Cerrar chat"
        >
          ✕
        </button>
      </header>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 pb-2" aria-live="polite">
        {turns.map((turn, i) => (
          <div key={i} className={turn.role === "customer" ? "text-right" : ""}>
            <p
              className="inline-block max-w-[86%] px-4 py-2.5 text-left text-[0.9375rem]"
              style={{
                borderRadius: 18,
                background: turn.role === "customer" ? accentColor : "rgba(255,255,255,.08)",
                color: turn.role === "customer" ? onAccent : "#fff",
                animation: "nl-rise 260ms cubic-bezier(.16,1,.3,1)",
              }}
            >
              {turn.text}
            </p>
            {turn.cta ? (
              <a
                href={turn.cta.url}
                target="_blank"
                rel="noopener noreferrer"
                className="nl-btn nl-btn--block mt-2"
                style={{ background: accentColor, color: onAccent, boxShadow: "none" }}
              >
                {turn.cta.label}
              </a>
            ) : null}
          </div>
        ))}
        {busy ? (
          <p className="px-1 text-[0.875rem] text-white/40" aria-label="Escribiendo">
            escribiendo…
          </p>
        ) : null}
      </div>

      <form onSubmit={send} className="flex gap-2 p-3">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="¿Cuánto vale?"
          maxLength={1000}
          className="flex-1 bg-white/10 px-4 text-[0.9375rem] text-white outline-none placeholder:text-white/35"
          style={{ borderRadius: 16, minHeight: 46, border: 0 }}
          aria-label="Mensaje"
        />
        <button
          type="submit"
          disabled={busy}
          className="nl-btn"
          style={{ background: accentColor, color: onAccent, boxShadow: "none" }}
        >
          {busy ? <span className="nl-spinner" /> : "Enviar"}
        </button>
      </form>
    </div>
  );
}
