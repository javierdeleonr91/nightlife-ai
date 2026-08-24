import { Panel, StatTile } from "@/components/ui";
import { UnansweredQuestions, type UnansweredItem } from "@/components/unanswered-questions";
import { HandoffList, type ConversationRow } from "@/components/handoff-list";

/**
 * El asistente, visto desde el panel.
 *
 * Club y RRPP ven exactamente lo mismo con datos distintos, así que la
 * pantalla es una sola y el dueño se lo pasa quien la usa. Duplicarla en dos
 * archivos garantizaría que dentro de un mes se hubieran separado.
 *
 * Tres bloques, en este orden a propósito:
 *   1. Lo que espera a una persona — es lo que hace abrir esto un sábado.
 *   2. Lo que la IA no supo — es lo que hace que mañana sepa más.
 *   3. Las conversaciones.
 */

export interface ChannelState {
  id: string;
  type: "WEBCHAT" | "INSTAGRAM" | "WHATSAPP";
  status: "CONNECTED" | "DISCONNECTED" | "ERROR" | string;
  autoReply: boolean;
  displayName: string | null;
}

const CANAL_LABEL: Record<string, string> = {
  WEBCHAT: "Web",
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
};

/** El estado real, sin maquillar. Un canal sin credenciales dice que no las tiene. */
function estadoTexto(c: ChannelState): string {
  if (c.type === "WEBCHAT") return "Activo";
  if (c.status === "CONNECTED") return c.autoReply ? "Conectado" : "Conectado · respuesta automática apagada";
  if (c.status === "ERROR") return "Error · hay que reconectar";
  return "Sin configurar";
}

export function AssistantPanels({
  channels,
  waiting,
  unanswered,
  conversations,
  clubId,
  llmConfigured,
}: {
  channels: ChannelState[];
  waiting: number;
  unanswered: UnansweredItem[];
  conversations: ConversationRow[];
  clubId?: string | null;
  llmConfigured: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      {!llmConfigured ? (
        <Panel>
          <h2 className="nl-h3">Asistente no configurado</h2>
          <p className="nl-muted mt-1 text-[0.88rem]">
            Falta la clave del modelo de lenguaje. Los mensajes se siguen
            recibiendo y guardando, pero el asistente no responderá solo. El
            resto del producto funciona con normalidad.
          </p>
        </Panel>
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Esperando persona" value={String(waiting)} tone={waiting > 0 ? "crit" : "neutral"} />
        <StatTile label="Sin respuesta" value={String(unanswered.length)} tone={unanswered.length > 0 ? "warn" : "neutral"} />
        <StatTile label="Conversaciones" value={String(conversations.length)} />
      </section>

      <section>
        <h2 className="nl-h3 mb-3">Canales</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {channels.map((c) => (
            <Panel key={c.id}>
              <p className="text-[0.9rem] font-medium">{CANAL_LABEL[c.type] ?? c.type}</p>
              <p className="nl-muted mt-1 text-[0.78rem]">{estadoTexto(c)}</p>
              {c.displayName ? (
                <p className="nl-muted mt-0.5 text-[0.75rem] opacity-70">{c.displayName}</p>
              ) : null}
            </Panel>
          ))}
        </div>
      </section>

      <section>
        <h2 className="nl-h3 mb-1">Preguntas sin respuesta</h2>
        <p className="nl-muted mb-3 text-[0.82rem]">
          Cuando el asistente no sabe algo no se lo inventa: lo deja aquí para
          que lo contestes tú. A partir de entonces ya lo sabe.
        </p>
        <UnansweredQuestions items={unanswered} clubId={clubId ?? null} />
      </section>

      <section>
        <h2 className="nl-h3 mb-3">Conversaciones</h2>
        <HandoffList rows={conversations} clubId={clubId ?? null} />
      </section>
    </div>
  );
}
