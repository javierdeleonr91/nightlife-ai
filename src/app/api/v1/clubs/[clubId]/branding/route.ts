import { z } from "zod";
import { NextResponse } from "next/server";
import { assertPermission, forTenant, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour, hash included.");

const schema = z.object({
  logoUrl: z.string().url().nullish(),
  coverImageUrl: z.string().url().nullish(),
  faviconUrl: z.string().url().nullish(),
  primaryColor: hex.nullish(),
  secondaryColor: hex.nullish(),
  backgroundColor: hex.nullish(),
  textColor: hex.nullish(),
  fontFamily: z.string().max(60).nullish(),
  borderRadius: z.number().int().min(0).max(40).nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:branding");

    const body = await parseBody(request, schema);
    // Los colores y el radio nunca se vacían: la página pública necesita un
    // valor. Vaciar un campo de color dejaría el CSS sin fondo.
    const data = Object.fromEntries(
      Object.entries(body).filter(([key, value]) =>
        key.endsWith("Color") || key === "borderRadius" || key === "fontFamily" ? value != null : true,
      ),
    );

    await withOwnerRls({ type: "CLUB", clubId }, (tx) =>
      tx.brandSettings.upsert({ where: { clubId }, create: { clubId, ...data }, update: data }),
    );
    await forTenant(principal, clubId).audit("club.branding", { fields: Object.keys(data) });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
