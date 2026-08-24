import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { AssistantPanels, type ChannelState } from "@/components/assistant-panels";
import { BetaFeedback } from "@/components/beta-feedback";
import { promoterOwner } from "@/lib/owner-context";
import { env } from "@nightlife/config/env";

/**
 * El asistente del RRPP.
 *
 * Antes esta pantalla filtraba por `promoterId`, que en el modelo nuevo NO
 * es el dueño: era «por quién llegó el cliente». Ahora va por `forOwner`,
 * que fija las variables de RLS en la transacción y deja que la base de
 * datos garantice el aislamiento en vez de confiar en el `where`.
 *
 * El resultado práctico: un RRPP no puede ver la conversación de otro
 * aunque alguien se equivoque escribiendo una consulta.
 */

export const dynamic = "force-dynamic";

function toRow(c: {
  id: string;
  status: string;
  channelType: string;
  lastMessageAt: Date;
  customer: { displayName: string | null } | null;
  messages: { content: string }[];
}) {
  return {
    id: c.id,
    status: c.status as "AI_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED",
    channelType: c.channelType,
    customerName: c.customer?.displayName ?? null,
    lastMessage: c.messages[0]?.content ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}

export default async function PromoterAssistantPage() {
  const principal = await requirePrincipal();
  const db = promoterOwner(principal);

  const [channels, conversations, unanswered, waiting] = await Promise.all([
    db.channels.list(),
    db.conversations.list({ take: 50 }),
    db.unanswered.list("OPEN"),
    db.conversations.waitingCount(),
  ]);

  return (
    <Page wide>
      <PageHeader
        eyebrow="Asistente"
        title="Tu asistente"
        action={<BetaFeedback />}
      />
      <AssistantPanels
        clubId={null}
        llmConfigured={Boolean(env().LLM_API_KEY)}
        waiting={waiting}
        channels={channels.map(
          (c): ChannelState => ({
            id: c.id,
            type: c.type as ChannelState["type"],
            status: c.status,
            autoReply: c.autoReply,
            displayName: c.displayName,
          }),
        )}
        conversations={conversations.map(toRow)}
        unanswered={unanswered.map((q) => ({
          id: q.id,
          originalQuestion: q.originalQuestion,
          detectedIntent: q.detectedIntent,
          channelType: q.channelType,
          reason: q.reason,
          createdAt: q.createdAt.toISOString(),
        }))}
      />
    </Page>
  );
}
