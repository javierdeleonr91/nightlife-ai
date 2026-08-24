import { z } from "zod";
import { NextResponse } from "next/server";
import { assertPermission, createInvite, forTenant, listInvites, revokeInvite } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Invitaciones que emite un club.
 *
 * Requiere `promoter:approve`: es el mismo permiso que aprobar a alguien a
 * mano, porque una invitación es exactamente eso hecho por adelantado.
 */

const createSchema = z.object({
  maxUses: z.number().int().min(0).max(200).default(1),
  expiresInDays: z.number().int().min(0).max(365).default(30),
  note: z.string().max(80).nullish(),
});

const revokeSchema = z.object({ inviteId: z.string().min(1).max(60) });

export async function GET(_request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "promoter:approve");
    return NextResponse.json({ invites: await listInvites(clubId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "promoter:approve");

    const body = await parseBody(request, createSchema);
    const invite = await createInvite({
      clubId,
      createdById: principal.userId,
      maxUses: body.maxUses,
      expiresInDays: body.expiresInDays,
      note: body.note ?? null,
    });

    await forTenant(principal, clubId).audit("club.invite.create", {
      inviteId: invite.id,
      maxUses: invite.maxUses,
    });

    return NextResponse.json({ invite });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "promoter:approve");

    const body = await parseBody(request, revokeSchema);
    await revokeInvite({ clubId, inviteId: body.inviteId });
    await forTenant(principal, clubId).audit("club.invite.revoke", { inviteId: body.inviteId });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
