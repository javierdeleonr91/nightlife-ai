"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, EmptyState, Badge, Icon } from "@/components/ui";
import { useToast } from "@/components/toast";

/**
 * Conversaciones y traspaso a humano.
 *
 * Mientras una conversación está en HUMAN_ACTIVE la IA no responde. Eso no
 * lo decide esta lista: lo decide `decide()` en el motor. Aquí solo se
 * cambia el estado, y por eso los tres botones son las tres únicas
 * transiciones que existen.
 */

export interface ConversationRow {
  id: string;
  status: "AI_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED";
  channelType: string;
  customerName: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
}

const ESTADO: Record<ConversationRow["status"], { label: string; tone: "live" | "warn" | "neutral" }> = {
  AI_ACTIVE: { label: "IA respondiendo", tone: "live" },
  WAITING_HUMAN: { label: "Esperando a una persona", tone: "warn" },
  HUMAN_ACTIVE: { label: "La llevas tú", tone: "neutral" },
  CLOSED: { label: "Cerrada", tone: "neutral" },
};

const CANAL: Record<string, string> = { WEBCHAT: "Web", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp" };

export function HandoffList({
  rows,
  clubId,
}: {
  rows: ConversationRow[];
  clubId?: string | null;
}) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();

  async function accion(id: string, action: "TAKE_OVER" | "BACK_TO_AI" | "CLOSE") {
    setOcupado(id);
    try {
      const res = await fetch(`/api/v1/assistant/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clubId, action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.ok(
        action === "TAKE_OVER"
          ? "La llevas tú. El asistente no responderá."
          : action === "BACK_TO_AI"
            ? "Devuelta al asistente."
            : "Conversación cerrada.",
      );
      router.refresh();
    } catch {
      toast.error("No se ha podido cambiar el estado.");
    } finally {
      setOcupado(null);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        glyph={<Icon name="chat" size={30} />}
        title="No hay conversaciones todavía"
        body="Aquí verás lo que te escriban por web, Instagram y WhatsApp."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((c) => {
        const e = ESTADO[c.status];
        return (
          <Panel key={c.id}>
            <div className="flex flex-wrap items-center gap-2 text-[0.72rem] opacity-60">
              <span>{CANAL[c.channelType] ?? c.channelType}</span>
              <span>{new Date(c.lastMessageAt).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <Badge tone={e.tone}>{e.label}</Badge>
            </div>

            <p className="mt-2 text-[0.95rem] font-medium">{c.customerName ?? "Cliente"}</p>
            {c.lastMessage ? (
              <p className="mt-1 line-clamp-2 text-[0.88rem] opacity-75">{c.lastMessage}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {c.status !== "HUMAN_ACTIVE" && c.status !== "CLOSED" ? (
                <button
                  type="button"
                  className="nl-btn nl-btn--primary"
                  disabled={ocupado === c.id}
                  onClick={() => void accion(c.id, "TAKE_OVER")}
                >
                  Atender yo
                </button>
              ) : null}
              {c.status === "HUMAN_ACTIVE" ? (
                <button
                  type="button"
                  className="nl-btn"
                  disabled={ocupado === c.id}
                  onClick={() => void accion(c.id, "BACK_TO_AI")}
                >
                  Devolver al asistente
                </button>
              ) : null}
              {c.status !== "CLOSED" ? (
                <button
                  type="button"
                  className="nl-btn"
                  disabled={ocupado === c.id}
                  onClick={() => void accion(c.id, "CLOSE")}
                >
                  Cerrar
                </button>
              ) : null}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
