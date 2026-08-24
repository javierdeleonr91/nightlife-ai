import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError } from "@nightlife/core/errors";
import { redeemInvite } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Canjear una invitación.
 *
 * Fíjate en lo que NO tiene esta ruta: ningún `clubId`. El cuerpo es solo un
 * código, y de él sale el club. No hay forma de pedir «méteme en el club X»
 * porque el parámetro no existe.
 */

const schema = z.object({ code: z.string().min(4).max(40) });

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    if (!principal.promoterId) throw AppError.forbidden("You don't have a promoter profile");

    const body = await parseBody(request, schema);
    const result = await redeemInvite({ code: body.code, promoterId: principal.promoterId });

    return NextResponse.json({
      ok: true,
      alreadyMember: result.alreadyMember,
      club: { name: result.clubName, slug: result.clubSlug },
    });
  } catch (error) {
    return apiError(error);
  }
}
