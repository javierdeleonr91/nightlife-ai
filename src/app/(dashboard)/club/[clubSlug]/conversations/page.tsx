import { notFound } from "next/navigation";
import { assertPermission, forTenant, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";

/**
 * Bandeja de conversaciones.
 *
 * Ordenada por lo que necesita a una persona, no por lo más reciente: lo que
 * el club abre este panel a buscar es a quién tiene esperando.
 */

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  WAITING_HUMAN: { text: "esperando persona", className: "text-rose-500" },
  HUMAN_ACTIVE: { text: "atendiendo", className: "text-amber-500" },
  POTENTIAL_PURCHASE: { text: "interesado", className: "text-emerald-500" },
  AI_ACTIVE: { text: "con el bot", className: "text-dash-muted" },
  CLOSED: { text: "cerrada", className: "text-dash-muted" },
};

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const club = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!club) notFound();
  assertPermission(principal, club.id, "conversation:read:own");

  // forTenant decide el alcance según RBAC: el staff ve todas, un promoter
  // solo las suyas. El filtro no se puede olvidar desde aquí.
  const db = forTenant(principal, club.id);
  const conversations = await db.conversations.list();

  const sorted = [...conversations].sort((a, b) => {
    const weight = (s: string) => (s === "WAITING_HUMAN" ? 0 : s === "POTENTIAL_PURCHASE" ? 1 : 2);
    return weight(a.status) - weight(b.status) || b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
  });

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-5 py-10">
      <header>
        <h1 className="text-2xl font-bold">Conversaciones</h1>
        <p className="text-sm text-dash-muted">Primero las que necesitan a una persona.</p>
      </header>

      {sorted.length === 0 ? (
        <p className="text-sm text-dash-muted">Todavía no hay conversaciones.</p>
      ) : (
        <ul className="divide-y divide-dash-line overflow-hidden rounded-xl border border-dash-line bg-dash-surface">
          {sorted.map((conversation) => {
            const label = STATUS_LABEL[conversation.status] ?? STATUS_LABEL.AI_ACTIVE!;
            return (
              <li key={conversation.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {conversation.channelType.toLowerCase()} ·{" "}
                    {conversation.lastIntent?.toLowerCase().replace(/_/g, " ") ?? "sin intent"}
                  </p>
                  <p className="text-xs text-dash-muted">
                    {conversation.lastMessageAt.toLocaleString("es-ES")}
                    {conversation.purchaseIntent ? " · con intención de compra" : ""}
                  </p>
                </div>
                <span className={`shrink-0 text-xs font-semibold ${label.className}`}>{label.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
