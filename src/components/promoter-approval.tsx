"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckMark } from "@/components/ui";

/** Aprobar o rechazar la solicitud de un promoter. Dos botones, sin ceremonia. */
export function PromoterApproval({
  clubId,
  promoterClubId,
}: {
  clubId: string;
  promoterClubId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "APPROVED" | "REJECTED") {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/v1/clubs/${clubId}/promoters/${promoterClubId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: decision }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(data?.error?.message ?? "Couldn't save that.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-none items-center gap-2">
      {error ? <span className="nl-error text-[0.8125rem]">{error}</span> : null}
      <button
        type="button"
        onClick={() => decide("REJECTED")}
        disabled={pending}
        className="nl-btn nl-btn--ghost"
      >
        Decline
      </button>
      <button
        type="button"
        onClick={() => decide("APPROVED")}
        disabled={pending}
        className="nl-btn nl-btn--hot"
      >
        {pending ? <span className="nl-spinner" /> : <CheckMark size={17} />}
        Approve
      </button>
    </div>
  );
}
