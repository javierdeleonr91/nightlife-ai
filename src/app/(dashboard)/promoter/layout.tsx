import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { AppShell, type NavItem } from "@/components/app-shell";

/**
 * Navegación del promoter (§2, §24).
 *
 * Seis destinos, no cuatro. Y con jerarquía real: «Plan» dejó de estar al
 * mismo nivel que «Eventos», porque nadie entra a esta aplicación a mirar su
 * suscripción. En móvil, la barra inferior lleva los cuatro primeros y el
 * resto vive en «More»; en escritorio se ven todos.
 *
 * «Profile» apunta a la pantalla de edición, no a la pública: desde el menú de
 * usuario se abre la pública en otra pestaña, que es lo que se quiere cuando
 * se va a compartir.
 */

export default async function PromoterLayout({ children }: { children: ReactNode }) {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const [promoter, user] = await Promise.all([
    prisma.promoter.findUnique({
      where: { id: principal.promoterId },
      select: { displayName: true, slug: true, photoUrl: true },
    }),
    prisma.user.findUnique({ where: { id: principal.userId }, select: { name: true, email: true } }),
  ]);
  if (!promoter || !user) redirect("/onboarding");

  const items: NavItem[] = [
    { href: "/promoter/home", label: "Inicio", icon: "home" },
    { href: "/promoter/events", label: "Eventos", icon: "calendar" },
    { href: "/promoter/profile", label: "Perfil", icon: "eye" },
    { href: "/promoter/clubs", label: "Discotecas", icon: "users" },
    { href: "/promoter/assistant", label: "Asistente", icon: "chat", secondary: true },
    { href: "/promoter/integrations", label: "Integraciones", icon: "plug", secondary: true },
    { href: "/promoter/subscription", label: "Plan", icon: "card", secondary: true },
    { href: "/promoter/settings", label: "Ajustes", icon: "shield", secondary: true },
  ];

  return (
    <AppShell
      items={items}
      brand={promoter.displayName}
      user={{
        name: user.name,
        email: user.email,
        role: "RRPP",
        avatarUrl: promoter.photoUrl,
        publicHref: `/${promoter.slug}`,
        profileHref: "/promoter/profile",
        settingsHref: "/promoter/settings",
        integrationsHref: "/promoter/integrations",
        subscriptionHref: "/promoter/subscription",
      }}
    >
      {children}
    </AppShell>
  );
}
