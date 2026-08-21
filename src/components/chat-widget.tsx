"use client";

import { useRef, useState } from "react";

/**
 * Webchat.
 *
 * Sin localStorage: el token de conversación vive en memoria durante la
 * visita. Es lo correcto para RGPD (nada persiste en el dispositivo sin
 * consentimiento) y elimina la necesidad de banner de cookies en la página
 * pública, que es justo lo que estorba a la conversión.
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
        body: JSON.stringify({
          clubSlug,
          promoterSlug,
          message,
          chatToken: tokenRef.current ?? undefined,
        }),
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
        // El asistente no está incluido en el plan de este promoter. Se dice
        // sin tecnicismos y sin dejar al cliente colgado.
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
      setTurns((t) => [
        ...t,
        { role: "bot", text: "Se me ha ido la conexión. Prueba otra vez en un momento." },
      ]);
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
        className="fixed bottom-5 right-5 z-40 rounded-full px-5 py-3 text-sm font-semibold shadow-lg"
        style={{ background: accentColor, color: "#fff" }}
      >
        Pregunta lo que sea
      </button>
    );
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-40 flex max-h-[75vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/90 backdrop-blur sm:inset-x-auto sm:right-5 sm:w-96">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-sm font-semibold text-white">Asistente</span>
        <button type="button" onClick={() => setOpen(false)} className="text-white/60 hover:text-white" aria-label="Cerrar chat">
          ✕
        </button>
      </header>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.map((turn, i) => (
          <div key={i} className={turn.role === "customer" ? "text-right" : ""}>
            <p
              className="inline-block max-w-[85%] rounded-2xl px-3.5 py-2 text-sm text-white"
              style={{ background: turn.role === "customer" ? accentColor : "rgba(255,255,255,.08)" }}
            >
              {turn.text}
            </p>
            {turn.cta ? (
              <a
                href={turn.cta.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block rounded-xl px-4 py-2.5 text-center text-sm font-bold text-white"
                style={{ background: accentColor }}
              >
                {turn.cta.label}
              </a>
            ) : null}
          </div>
        ))}
        {busy ? <p className="text-sm text-white/40">escribiendo…</p> : null}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-white/10 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="¿Cuánto vale?"
          maxLength={1000}
          className="flex-1 rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus-visible:ring-2"
          aria-label="Mensaje"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: accentColor }}
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
