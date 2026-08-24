import { z } from "zod";
import { NextResponse } from "next/server";
import { assertPermission, chooseChannel } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/** Elegir qué canal/equipo de la organización queda conectado a este club. */

const schema = z.object({
  channelId: z.string().min(1).max(120),
  channelName: z.string().min(1).max(120),
});

export async function POST(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:integrations");

    const body = await parseBody(request, schema);
    const integration = await chooseChannel({
      clubId,
      channelId: body.channelId,
      channelName: body.channelName,
    });

    return NextResponse.json({ ok: true, integration });
  } catch (error) {
    return apiError(error);
  }
}
