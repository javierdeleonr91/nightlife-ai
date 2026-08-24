import { Page, PageHeader } from "@/components/app-shell";
import { Badge, EmptyState, Icon, Panel } from "@/components/ui";
import { requireClubPage } from "@/lib/club-page";
import { forTenant, listInvites } from "@nightlife/db";
import { PromoterApproval } from "@/components/promoter-approval";
import { ClubInvites } from "@/components/club-invites";

/**
 * Promoters del club (§48).
 *
 * La aprobación es obligatoria y por eso está aquí arriba: sin ella cualquiera
 * podría montar un escaparate con la marca de este club.
 */

export const dynamic = "force-dynamic";

export default async function ClubPromotersPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { principal, club, base } = await requireClubPage(clubSlug, "club:read");

  const db = forTenant(principal, club.id);
  const [links, invites] = await Promise.all([db.promoters.list(), listInvites(club.id)]);

  const pending = links.filter((l) => l.status === "PENDING");
  const approved = links.filter((l) => l.status === "APPROVED");

  return (
    <Page>
      <PageHeader
        eyebrow={club.name}
        title="Promoters"
        back={{ href: `${base}/overview`, label: "Home" }}
        crumbs={[{ label: "Home", href: `${base}/overview` }, { label: "Promoters" }]}
      />

      <Panel className="mb-4">
        <p className="nl-eyebrow mb-2">How someone joins</p>
        <p className="nl-muted text-[0.9375rem]">
          A promoter creates their profile and asks to join using your club identifier,{" "}
          <span className="nl-num">{club.slug}</span>. Their request lands here. Until you approve
          it, none of your events appear on their page.
        </p>
      </Panel>

      <Panel className="mb-4">
        <p className="nl-eyebrow mb-1">Invite a promoter</p>
        <p className="nl-muted mb-4 text-[0.9375rem]">
          Send them a code. They enter it in their Clubs tab and they&apos;re in — no request to
          approve afterwards, because creating the invite is the approval.
        </p>
        <ClubInvites
          clubId={club.id}
          initial={invites.map((invite) => ({
            id: invite.id,
            code: invite.code,
            expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
            maxUses: invite.maxUses,
            usedCount: invite.usedCount,
            revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
            note: invite.note,
          }))}
        />
      </Panel>

      {pending.length > 0 ? (
        <section className="mb-5">
          <p className="nl-eyebrow mb-3">Waiting for you</p>
          <ul className="nl-stagger grid gap-2">
            {pending.map((link) => (
              <li key={link.id} className="nl-card nl-card--flat">
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{link.promoter.displayName}</p>
                    <p className="nl-dim text-[0.8125rem]">
                      /{link.promoter.slug}
                      {link.promoter.city ? ` · ${link.promoter.city}` : ""}
                    </p>
                  </div>
                  <PromoterApproval clubId={club.id} promoterClubId={link.id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <p className="nl-eyebrow mb-3">On your team</p>
        {approved.length === 0 ? (
          <EmptyState
            glyph={<Icon name="users" size={26} />}
            title="No promoters yet"
            body={`Share your club identifier — ${club.slug} — with your RRPPs. They paste it when they sign up and their request lands here.`}
          />
        ) : (
          <ul className="nl-stagger grid gap-2">
            {approved.map((link) => (
              <li key={link.id} className="nl-card nl-card--flat">
                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{link.promoter.displayName}</p>
                    <p className="nl-dim text-[0.8125rem]">/{link.promoter.slug}</p>
                  </div>
                  <Badge tone="live" dot>
                    Active
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
