import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AppError } from "@nightlife/core/errors";
import { requirePrincipalApi } from "@/lib/require-api";
import { ownerFromRequest } from "@/lib/owner-context";
import { forOwner } from "@nightlife/db/owner";

/**
 * Encender o apagar la respuesta automática de un canal.
 *
 * Apagada, los mensajes siguen entrando y guardándose: lo único que cambia
 * es que la IA no contesta sola. Es lo que quiere un club la noche que tiene
 * a alguien atendiendo el WhatsApp a mano.
 */

const Body = z.object({
  clubId: z.string().nullable().optional(),
  autoReply: z.boolean(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const db = forOwner(principal, ownerFromRequest(principal, body.clubId ?? null));
    const r = await db.channels.setAutoReply(id, body.autoReply);
    if (r.count === 0) throw AppError.notFound("Channel");
    return NextResponse.json({ autoReply: body.autoReply });
  } catch (error) {
    return apiError(error);
  }
}
