import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AppError } from "@nightlife/core/errors";
import { requirePrincipalApi } from "@/lib/require-api";
import { ownerFromRequest } from "@/lib/owner-context";
import { forOwner } from "@nightlife/db/owner";

/**
 * Feedback de la beta.
 *
 * Cuatro tipos y un texto. Deliberadamente pequeño: un formulario con diez
 * campos no lo rellena nadie, y lo que hace falta durante un piloto es que
 * la gente escriba «esto no me carga» en el momento en que no le carga.
 */

const Body = z.object({
  clubId: z.string().nullable().optional(),
  kind: z.enum(["ERROR", "SUGGESTION", "INTEGRATION", "OTHER"]),
  message: z.string().trim().min(3).max(4000),
  path: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(req, Body);
    const db = forOwner(principal, ownerFromRequest(principal, body.clubId ?? null));
    await db.feedback.create({
      kind: body.kind,
      message: body.message,
      path: body.path ?? null,
    });
    return NextResponse.json({ received: true });
  } catch (error) {
    return apiError(error);
  }
}
