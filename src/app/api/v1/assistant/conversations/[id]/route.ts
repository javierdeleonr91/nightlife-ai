import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AppError } from "@nightlife/core/errors";
import { requirePrincipalApi } from "@/lib/require-api";
import { ownerFromRequest } from "@/lib/owner-context";
import { forOwner } from "@nightlife/db/owner";

/**
 * Handoff humano.
 *
 * Tres transiciones y ninguna más: coger la conversación, devolverla a la
 * IA, cerrarla. Mientras está en HUMAN_ACTIVE el motor no responde — eso lo
 * decide `decide()` en @nightlife/ai/beta-engine, no esta ruta.
 */

const Body = z.object({
  clubId: z.string().nullable().optional(),
  action: z.enum(["TAKE_OVER", "BACK_TO_AI", "CLOSE"]),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const db = forOwner(principal, ownerFromRequest(principal, body.clubId ?? null));

    const result =
      body.action === "TAKE_OVER"
        ? await db.conversations.takeOver(id)
        : body.action === "BACK_TO_AI"
          ? await db.conversations.backToAi(id)
          : await db.conversations.close(id);

    // count === 0 significa «no es tuya o no existe», y las dos cosas se
    // responden igual: decir cuál de las dos confirmaría que existe.
    if (result.count === 0) throw AppError.notFound("Conversation");

    const status =
      body.action === "TAKE_OVER" ? "HUMAN_ACTIVE" : body.action === "BACK_TO_AI" ? "AI_ACTIVE" : "CLOSED";
    return NextResponse.json({ status });
  } catch (error) {
    return apiError(error);
  }
}
