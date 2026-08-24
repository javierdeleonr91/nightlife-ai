import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AppError } from "@nightlife/core/errors";
import { requirePrincipalApi } from "@/lib/require-api";
import { ownerFromRequest } from "@/lib/owner-context";
import { forOwner } from "@nightlife/db/owner";

/**
 * Las preguntas que la IA no supo responder.
 *
 * Es la lista que convierte «mi bot no sabía» en «mi bot ya lo sabe». Sin
 * esta pantalla, no responder sería solo un fallo; con ella, es el
 * mecanismo por el que el asistente mejora sin tocar el modelo.
 */

const Query = z.object({
  clubId: z.string().nullable().optional(),
  status: z.enum(["OPEN", "ANSWERED", "DISMISSED"]).default("OPEN"),
});

export async function GET(req: NextRequest) {
  try {
    const principal = await requirePrincipalApi();
    const parsed = Query.parse({
      clubId: req.nextUrl.searchParams.get("clubId"),
      status: req.nextUrl.searchParams.get("status") ?? undefined,
    });
    const owner = ownerFromRequest(principal, parsed.clubId ?? null);
    const db = forOwner(principal, owner);
    const items = await db.unanswered.list(parsed.status);
    return NextResponse.json({ items });
  } catch (error) {
    return apiError(error);
  }
}
