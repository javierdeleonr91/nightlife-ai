import { notFound } from "next/navigation";
import type { Permission } from "@nightlife/core/rbac";
import { assertPermission, assertTenantAccess, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";

/**
 * Resolver club + acceso, que es lo primero que hace cada página del panel.
 *
 * Repetirlo en once páginas es once oportunidades de olvidar la comprobación
 * de permiso en una. Aquí es un parámetro obligatorio: no se puede llamar sin
 * decir qué permiso exige la pantalla.
 */
export async function requireClubPage(clubSlug: string, permission: Permission) {
  const principal = await requirePrincipal();
  // `clubs` no está bajo RLS pero `brand_settings` sí, así que la relación
  // anidada se lee aparte y ya con el club fijado. Si se dejara en el
  // `include`, con nl_app volvería siempre null y el panel se vería sin
  // marca — sin un solo error en el log.
  const base = await prisma.club.findUnique({ where: { slug: clubSlug } });
  if (!base) notFound();
  const brand = await withOwnerRls({ type: "CLUB", clubId: base.id }, (tx) =>
    tx.brandSettings.findUnique({ where: { clubId: base.id } }),
  );
  const club = { ...base, brand };
  assertTenantAccess(principal, club.id);
  assertPermission(principal, club.id, permission);
  return { principal, club, base: `/club/${club.slug}` };
}
