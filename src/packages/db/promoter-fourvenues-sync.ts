import { canonicalPublicEventUrl } from "@nightlife/ticketing/fourvenues";
import type { NormalizedEvent } from "@nightlife/ticketing/types";

import { withOwnerRls } from "./owner";

export interface PromoterFourvenuesSyncReport {
  readonly saved: number;
  readonly skipped: number;
}

export async function syncPromoterFourvenues(args: {
  promoterId: string;
  events: readonly NormalizedEvent[];
}): Promise<PromoterFourvenuesSyncReport> {
  let saved = 0;
  let skipped = 0;
  const now = new Date();

  for (const incoming of args.events) {
    const startsAtIso = incoming.startsAt?.value;
    if (!startsAtIso) {
      skipped += 1;
      continue;
    }

    const startsAt = new Date(startsAtIso);
    if (Number.isNaN(startsAt.getTime())) {
      skipped += 1;
      continue;
    }

    let sourceUrl: string;
    try {
      sourceUrl = canonicalPublicEventUrl(incoming.sourceUrl);
    } catch {
      skipped += 1;
      continue;
    }

    await withOwnerRls(
      { type: "PROMOTER", promoterId: args.promoterId },
      (tx) =>
        tx.promoterFourvenuesEvent.upsert({
          where: {
            promoterId_sourceUrl: {
              promoterId: args.promoterId,
              sourceUrl,
            },
          },
          create: {
            promoterId: args.promoterId,
            sourceUrl,
            checkoutUrl: incoming.sourceUrl,
            name: incoming.name.value,
            startsAt,
            venueName: incoming.venueName?.value ?? null,
            imageUrl: incoming.imageUrl?.value ?? null,
            djLineup: incoming.dj?.value ?? [],
            currentPriceCents: incoming.currentPrice?.value ?? null,
            soldOut: incoming.availability.value === "SOLD_OUT",
            isActive: true,
            lastSeenAt: now,
          },
          update: {
            checkoutUrl: incoming.sourceUrl,
            name: incoming.name.value,
            startsAt,
            venueName: incoming.venueName?.value ?? null,
            imageUrl: incoming.imageUrl?.value ?? null,
            djLineup: incoming.dj?.value ?? [],
            currentPriceCents: incoming.currentPrice?.value ?? null,
            soldOut: incoming.availability.value === "SOLD_OUT",
            isActive: true,
            lastSeenAt: now,
          },
        }),
    );

    saved += 1;
  }

  if (saved > 0 || args.events.length === 0) {
    const activeSourceUrls = args.events.flatMap((event) => {
      try {
        return [canonicalPublicEventUrl(event.sourceUrl)];
      } catch {
        return [];
      }
    });

    await withOwnerRls(
      { type: "PROMOTER", promoterId: args.promoterId },
      (tx) =>
        tx.promoterFourvenuesEvent.updateMany({
          where: {
            promoterId: args.promoterId,
            isActive: true,
            sourceUrl: { notIn: activeSourceUrls },
          },
          data: { isActive: false },
        }),
    );
  }

  return { saved, skipped };
}

export function disablePromoterFourvenuesEvents(promoterId: string) {
  return withOwnerRls(
    { type: "PROMOTER", promoterId },
    (tx) =>
      tx.promoterFourvenuesEvent.updateMany({
        where: { promoterId },
        data: { isActive: false },
      }),
  );
}
