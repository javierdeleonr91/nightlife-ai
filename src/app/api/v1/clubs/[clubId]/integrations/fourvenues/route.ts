import { z } from "zod";
import { NextResponse } from "next/server";
import {
  assertPermission,
  connectFourvenues,
  disconnectIntegration,
  forTenant,
  getIntegration,
} from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Conectar y desconectar Fourvenues.
 *
 * Reglas que se cumplen aquí y no en la UI, porque la UI se puede saltar:
 *
 *  · La key entra por el cuerpo de un POST. Nunca por la URL, donde acabaría
 *    en los logs de acceso de medio internet.
 *  · La respuesta **jamás** devuelve la key. Ni la que acabas de mandar. El
 *    tipo `IntegrationView` no tiene el campo, así que no hay forma de que se
 *    escape por descuido.
 *  · Se valida contra Fourvenues antes de guardar. Una key mala no deja una
 *    fila «conectada» mintiendo en la pantalla.
 *  · Solo el dueño o el manager del club: `club:integrations`.
 */

const connectSchema = z.object({
  apiKey: z.string().min(8).max(400),
  environment: z.enum(["ALPHA", "PRODUCTION"]).default("PRODUCTION"),
});

export async function GET(_request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:read");
    return NextResponse.json({ integration: await getIntegration(clubId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:integrations");

    const body = await parseBody(request, connectSchema);
    const result = await connectFourvenues({
      clubId,
      apiKey: body.apiKey,
      environment: body.environment,
    });

    // La auditoría registra que alguien conectó, no con qué. Ni el hint.
    await forTenant(principal, clubId).audit("club.integration.connect", {
      provider: "FOURVENUES",
      environment: body.environment,
      ok: result.ok,
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, message: result.message ?? "We couldn't connect to Fourvenues." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      channels: result.channels,
      integration: result.view,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:integrations");

    await disconnectIntegration(clubId);
    await forTenant(principal, clubId).audit("club.integration.disconnect", {
      provider: "FOURVENUES",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
