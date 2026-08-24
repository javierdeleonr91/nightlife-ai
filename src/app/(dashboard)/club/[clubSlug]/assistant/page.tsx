import { notFound } from "next/navigation";
import { assertPermission, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { AssistantPanels, type ChannelState } from "@/components/assistant-panels";
import { BetaFeedback } from "@/components/beta-feedback";
import { clubOwner } from "@/lib/owner-context";
import { env } from "@nightlife/config/env";

/**
 * El asistente del club.
 *
 * Misma pantalla que la del RRPP con datos distintos: los dos son
 * inquilinos de pleno derecho y no hay razón para que vean cosas diferentes.
 *
 * Pasa por `forOwner`, que fija las variables de RLS dentro de la
 * transacción. El `where` de aplicación sigue puesto además de las
 * políticas: si esto llegara a ejecutarse contra una conexión sin RLS, el
 * filtro seguiría ahí.
 */

export const dynamic = "force-dynamic";

/** Lo que espera una persona va arriba: es lo que hace abrir esto un sábado. */
const PESO: Record<string, number> = { WAITING_HUMAN: 0, HUMAN_ACTIVE: 1, AI_ACTIVE: 2, CLOSED: 3 };

export default async function AssistantPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertPermission(principal, club.id, "conversation:read:own");

  const db = clubOwner(principal, club.id);
  const [channels, conversations, unanswered, waiting] = await Promise.all([
    db.channels.list(),
    db.conversations.list({ take: 50 }),
    db.unanswered.list("OPEN"),
    db.conversations.waitingCount(),
  ]);

  const ordenadas = [...conversations].sort(
    (a, b) =>
      (PESO[a.status] ?? 9) - (PESO[b.status] ?? 9) ||
      b.lastMessageAt.getTime() - a.lastMessageAt.getTime(),
  );

  return (
    <Page wide>
      <PageHeader
        eyebrow={club.name}
        title="Asistente"
        back={{ href: `/club/${club.slug}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `/club/${club.slug}/overview` }, { label: "Asistente" }]}
        action={<BetaFeedback clubId={club.id} />}
      />
      <AssistantPanels
        clubId={club.id}
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
        conversations={ordenadas.map((c) => ({
          id: c.id,
          status: c.status as "AI_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED",
          channelType: c.channelType,
          customerName: c.customer?.displayName ?? null,
          lastMessage: c.messages[0]?.content ?? null,
          lastMessageAt: c.lastMessageAt.toISOString(),
        }))}
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
