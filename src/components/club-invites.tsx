"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Icon } from "@/components/ui";
import { useToast } from "@/components/toast";
import { formatInviteCode } from "@nightlife/core/invite";

/**
 * Invitar promoters (§16, lado del club).
 *
 * Un código, un botón de copiar, y la lista de los que siguen vivos. Sin
 * formulario de configuración: el club quiere dar de alta a alguien, no
 * rellenar campos. Los valores por defecto — un uso, 30 días — son los que
 * necesita el 90% de las veces, y para el grupo de RRPPs hay un segundo botón
 * que hace uno reutilizable.
 */

export interface InviteRow {
  id: string;
  code: string;
  expiresAt: string | null;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  note: string | null;
}

export function ClubInvites({ clubId, initial }: { clubId: string; initial: InviteRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [invites, setInvites] = useState(initial);
  const [busy, setBusy] = useState(false);

  const endpoint = `/api/v1/clubs/${clubId}/invites`;

  async function create(maxUses: number) {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUses, expiresInDays: 30 }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.invite) {
        toast.error(data?.error?.message ?? "Couldn't create the invite.");
        return;
      }
      setInvites((list) => [data.invite as InviteRow, ...list]);
      toast.ok("Invite created");
      router.refresh();
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteId: string) {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteId }),
      });
      if (!response.ok) {
        toast.error("Couldn't cancel that invite.");
        return;
      }
      setInvites((list) =>
        list.map((i) => (i.id === inviteId ? { ...i, revokedAt: new Date().toISOString() } : i)),
      );
      toast.ok("Invite cancelled");
      router.refresh();
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(formatInviteCode(code));
      toast.ok("Code copied");
    } catch {
      toast.error("Couldn't copy — select it and copy by hand.");
    }
  }

  const live = invites.filter((i) => !i.revokedAt);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => create(1)} disabled={busy} className="nl-btn nl-btn--hot">
          <Icon name="plus" size={17} />
          New invite
        </button>
        <button
          type="button"
          onClick={() => create(0)}
          disabled={busy}
          className="nl-btn nl-btn--ghost"
        >
          Reusable code
        </button>
      </div>

      {live.length === 0 ? (
        <p className="nl-hint">
          No active invites. Create one and send the code to your promoter — they enter it in their
          Clubs tab.
        </p>
      ) : (
        <ul className="grid gap-2">
          {live.map((invite) => {
            const usesLeft = invite.maxUses === 0 ? null : invite.maxUses - invite.usedCount;
            return (
              <li key={invite.id} className="nl-integration">
                <span className="nl-num flex-1 text-[1.05rem] tracking-[0.16em]">
                  {formatInviteCode(invite.code)}
                </span>
                <Badge tone={usesLeft === null || usesLeft > 0 ? "live" : "warn"}>
                  {invite.maxUses === 0
                    ? `${invite.usedCount} used`
                    : `${usesLeft} of ${invite.maxUses} left`}
                </Badge>
                <button
                  type="button"
                  onClick={() => copy(invite.code)}
                  className="nl-btn nl-btn--quiet"
                >
                  <Icon name="copy" size={16} />
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => revoke(invite.id)}
                  disabled={busy}
                  className="nl-btn nl-btn--ghost"
                >
                  Cancel
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
