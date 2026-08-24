import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { assertPermission, forTenant, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({ status: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]) });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ clubId: string; promoterClubId: string }> },
) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId, promoterClubId } = await params;
    assertPermission(principal, clubId, "promoter:approve");

    const body = await parseBody(request, schema);

    // updateMany con clubId en el where: aunque llegue el id de otra
    // solicitud, no se toca nada de otro club.
    const result = await withOwnerRls({ type: "CLUB", clubId }, (tx) =>
      tx.promoterClub.updateMany({
        where: { id: promoterClubId, clubId },
        data: {
          status: body.status,
          approvedAt: body.status === "APPROVED" ? new Date() : null,
        },
      }),
    );
    if (result.count === 0) throw AppError.notFound("Request");

    await forTenant(principal, clubId).audit("promoter.decision", {
      promoterClubId,
      status: body.status,
    });

    return NextResponse.json({ status: body.status });
  } catch (error) {
    return apiError(error);
  }
}
