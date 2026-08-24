import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { AppError } from "@nightlife/core/errors";
import { requirePrincipalApi } from "@/lib/require-api";
import { ownerFromRequest } from "@/lib/owner-context";
import { forOwner, ownerWhere } from "@nightlife/db/owner";

/**
 * Responder una pregunta sin respuesta.
 *
 * Lo importante pasa aquí: al guardar la respuesta NO se guarda solo la
 * respuesta. Se crea también una FAQ con esa pregunta y esa respuesta, y a
 * partir de ese momento el emparejamiento por significado la encuentra
 * aunque el siguiente cliente la formule de otra manera.
 *
 * No hay entrenamiento de ningún modelo. Es una fila más en la base de
 * conocimiento, que es justo lo que hace que el efecto sea inmediato y
 * reversible.
 */

const Body = z.object({
  clubId: z.string().nullable().optional(),
  answer: z.string().trim().min(2).max(2000).optional(),
  dismiss: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const owner = ownerFromRequest(principal, body.clubId ?? null);
    const db = forOwner(principal, owner);

    if (body.dismiss) {
      const r = await db.unanswered.dismiss(id);
      if (r.count === 0) throw AppError.notFound("Question");
      return NextResponse.json({ status: "DISMISSED" });
    }

    if (!body.answer) throw AppError.validation("Falta la respuesta.");

    const result = await db.tx(async (tx) => {
      const where = ownerWhere(owner);
      const question = await tx.unansweredQuestion.findFirst({ where: { id, ...where } });
      if (!question) return null;

      await tx.unansweredQuestion.updateMany({
        where: { id, ...where },
        data: {
          status: "ANSWERED",
          answer: body.answer,
          answeredBy: principal.userId,
          resolvedAt: new Date(),
        },
      });

      // La FAQ es lo que hace que esto sirva para algo. La pregunta se
      // guarda tal cual la escribió el cliente: su forma real de preguntar
      // es justo la señal que queremos conservar.
      const faq =
        owner.type === "CLUB"
          ? await tx.fAQ.create({
              data: {
                clubId: owner.clubId,
                question: question.originalQuestion,
                answer: body.answer!,
                intent: question.detectedIntent,
              },
            })
          : await tx.promoterFAQ.create({
              data: {
                promoterId: owner.promoterId,
                question: question.originalQuestion,
                answer: body.answer!,
                intent: question.detectedIntent,
              },
            });

      return { faqId: faq.id };
    });

    if (!result) throw AppError.notFound("Question");
    return NextResponse.json({ status: "ANSWERED", ...result });
  } catch (error) {
    return apiError(error);
  }
}
