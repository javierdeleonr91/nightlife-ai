"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, EmptyState, Badge, Icon } from "@/components/ui";
import { useToast } from "@/components/toast";

/**
 * Preguntas sin respuesta.
 *
 * Es la pantalla que convierte «mi bot no supo» en «mi bot ya lo sabe». Al
 * guardar una respuesta se crea una FAQ con la pregunta TAL Y COMO la
 * escribió el cliente, y el emparejamiento por significado la encuentra
 * aunque el siguiente la formule distinto.
 *
 * Deliberadamente sin filtros, sin paginación y sin buscador: durante el
 * piloto lo que hay que conseguir es que alguien conteste, no que navegue.
 */

export interface UnansweredItem {
  id: string;
  originalQuestion: string;
  detectedIntent: string | null;
  channelType: string | null;
  reason: string | null;
  createdAt: string;
}

const MOTIVO: Record<string, string> = {
  NO_DATA: "Sin información suficiente",
  STALE_DATA: "El dato estaba caducado",
  AMBIGUOUS: "No estaba claro de qué evento hablaba",
  NO_LLM: "El asistente no estaba configurado",
};

const CANAL: Record<string, string> = {
  WEBCHAT: "Web",
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
};

function cuando(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export function UnansweredQuestions({
  items,
  clubId,
}: {
  items: UnansweredItem[];
  clubId?: string | null;
}) {
  const [abierta, setAbierta] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function enviar(id: string, dismiss = false) {
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/assistant/unanswered/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          dismiss ? { clubId, dismiss: true } : { clubId, answer: texto },
        ),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.ok(dismiss ? "Descartada." : "Guardado. El asistente ya puede responderla.");
      setAbierta(null);
      setTexto("");
      router.refresh();
    } catch {
      toast.error("No se ha podido guardar. Inténtalo otra vez.");
    } finally {
      setEnviando(false);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        glyph={<Icon name="chat" size={30} />}
        title="No hay preguntas pendientes"
        body="Cuando el asistente no sepa responder algo, aparecerá aquí en vez de inventárselo."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((q) => (
        <Panel key={q.id}>
          <div className="flex flex-wrap items-center gap-2 text-[0.72rem] opacity-60">
            {q.channelType ? <span>{CANAL[q.channelType] ?? q.channelType}</span> : null}
            <span>{cuando(q.createdAt)}</span>
            {q.reason ? <Badge tone="warn">{MOTIVO[q.reason] ?? q.reason}</Badge> : null}
          </div>

          <p className="mt-2 text-[0.98rem] leading-snug">“{q.originalQuestion}”</p>

          {abierta === q.id ? (
            <div className="mt-3 flex flex-col gap-2">
              <label className="nl-sr" htmlFor={`r-${q.id}`}>
                Respuesta
              </label>
              <textarea
                id={`r-${q.id}`}
                className="nl-input min-h-[88px]"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Escribe la respuesta como se la darías a un cliente."
                autoFocus
              />
              <p className="text-[0.72rem] opacity-55">
                Se guarda como conocimiento del asistente. Las próximas veces
                responderá solo, aunque se lo pregunten con otras palabras.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="nl-btn nl-btn--primary"
                  disabled={enviando || texto.trim().length < 2}
                  onClick={() => void enviar(q.id)}
                >
                  Guardar respuesta
                </button>
                <button
                  type="button"
                  className="nl-btn"
                  disabled={enviando}
                  onClick={() => {
                    setAbierta(null);
                    setTexto("");
                  }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="nl-btn nl-btn--primary"
                onClick={() => {
                  setAbierta(q.id);
                  setTexto("");
                }}
              >
                Añadir respuesta
              </button>
              <button
                type="button"
                className="nl-btn"
                disabled={enviando}
                onClick={() => void enviar(q.id, true)}
              >
                Descartar
              </button>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
