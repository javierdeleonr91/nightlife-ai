import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { assertTenantAccess, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";
import { requirePrincipal } from "@/lib/session";
import { AppShell, type NavItem } from "@/components/app-shell";

/**
 * El layout resuelve el club, el acceso y el usuario una sola vez para toda la
 * sección. También trae el número de conversaciones esperando: es el único
 * contador que merece un badge, porque es el único que significa que hay
 * alguien esperando al otro lado.
 */

export default async function ClubLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const principal = await requirePrincipal();

  const [club, user] = await Promise.all([
    prisma.club.findUnique({ where: { slug: clubSlug } }),
    prisma.user.findUnique({ where: { id: principal.userId }, select: { name: true, email: true } }),
  ]);
  if (!club || !user) notFound();
  assertTenantAccess(principal, club.id);

  // `conversations` y `brand_settings` están bajo RLS: las dos lecturas van
  // con el club fijado en la transacción, no con el cliente global.
  //
  // El logo NO puede venir en un `include` del `findUnique` de arriba, que
  // es lo natural y lo que había antes: `clubs` no está bajo RLS pero
  // `brand_settings` sí, así que esa relación anidada volvería siempre null
  // con `nl_app` — y sin un solo error, el panel se vería sin marca. No es
  // una consulta de más: entra en la transacción que ya estaba abierta para
  // contar las conversaciones.
  const [waiting, brand] = await withOwnerRls({ type: "CLUB", clubId: club.id }, (tx) =>
    Promise.all([
      tx.conversation.count({
        where: { ownerType: "CLUB", ownerClubId: club.id, status: "WAITING_HUMAN" },
      }),
      tx.brandSettings.findUnique({ where: { clubId: club.id }, select: { logoUrl: true } }),
    ]),
  );

  const base = `/club/${club.slug}`;

  // Los tres primeros van en la barra inferior del móvil; el resto, en «More».
  // «Promoters» ya no está aquí, y es una decisión de producto, no un
  // olvido: la gestión de RRPP por parte del club deja de ser funcionalidad
  // principal (§2). La ruta y sus tablas siguen existiendo —borrarlas sería
  // destructivo y prematuro— pero no se navega hasta ellas ni se construye
  // nada nuevo encima.
  const items: NavItem[] = [
    { href: `${base}/overview`, label: "Inicio", icon: "home" },
    { href: `${base}/events`, label: "Eventos", icon: "calendar" },
    { href: `${base}/assistant`, label: "Asistente", icon: "chat", badge: waiting },
    { href: `${base}/vip`, label: "VIP", icon: "crown", secondary: true },
    { href: `${base}/integrations`, label: "Integraciones", icon: "plug", secondary: true },
    { href: `${base}/branding`, label: "Marca", icon: "palette", secondary: true },
    { href: `${base}/subscription`, label: "Plan", icon: "card", secondary: true },
    { href: `${base}/settings`, label: "Ajustes", icon: "shield", secondary: true },
  ];

  return (
    <AppShell
      items={items}
      brand={club.name}
      user={{
        name: user.name,
        email: user.email,
        role: principal.clubRoles.get(club.id) === "CLUB_OWNER" ? "Propietario" : "Gestor",
        avatarUrl: brand?.logoUrl ?? null,
        publicHref: `/c/${club.slug}`,
        profileHref: `${base}/profile`,
        settingsHref: `${base}/settings`,
        integrationsHref: `${base}/integrations`,
        subscriptionHref: `${base}/subscription`,
      }}
    >
      {children}
    </AppShell>
  );
}
