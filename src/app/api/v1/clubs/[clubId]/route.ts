import { z } from "zod";
import { NextResponse } from "next/server";
import { assertPermission, forTenant, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/** Los campos que el club puede editar de su propia ficha. */
const schema = z.object({
  name: z.string().min(2).max(80).nullish(),
  city: z.string().min(2).max(80).nullish(),
  description: z.string().max(400).nullish(),
  address: z.string().max(200).nullish(),
  phone: z.string().max(30).nullish(),
  whatsapp: z.string().max(30).nullish(),
  instagram: z.string().max(60).nullish(),
  website: z.string().url().max(200).nullish(),
  openingHours: z.string().max(200).nullish(),
  minAge: z.number().int().min(16).max(30).nullish(),
  dressCode: z.string().max(300).nullish(),
  policies: z.string().max(1000).nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "club:update");

    const body = await parseBody(request, schema);

    // name y city no se pueden vaciar: sin ellos la página pública no existe.
    const data = Object.fromEntries(
      Object.entries(body).filter(([key, value]) =>
        key === "name" || key === "city" ? typeof value === "string" && value.length > 0 : true,
      ),
    );

    const club = await prisma.club.update({ where: { id: clubId }, data });
    await forTenant(principal, clubId).audit("club.update", { fields: Object.keys(data) });

    return NextResponse.json({ id: club.id, slug: club.slug });
  } catch (error) {
    return apiError(error);
  }
}
