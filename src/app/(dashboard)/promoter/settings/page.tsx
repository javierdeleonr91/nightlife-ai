import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, ButtonLink, Icon, Panel } from "@/components/ui";
import { signInMethodLabel, signInMethodsFor } from "@nightlife/core/oauth";

export const dynamic = "force-dynamic";

export default async function PromoterSettingsPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const [promoter, user] = await Promise.all([
    prisma.promoter.findUnique({
      where: { id: principal.promoterId },
      select: { slug: true, displayName: true },
    }),
    prisma.user.findUnique({
      where: { id: principal.userId },
      select: {
        name: true,
        email: true,
        createdAt: true,
        // Si tiene contraseña se sabe por aquí, no por una fila de identidad.
        passwordHash: true,
        // Solo el nombre del proveedor: ni tokens, ni subjects, ni nada que
        // sirva para suplantar a nadie.
        identities: { select: { provider: true }, orderBy: { lastUsedAt: "desc" } },
      },
    }),
  ]);
  if (!promoter || !user) redirect("/onboarding");

  // Puede tener varios: contraseña y Google a la vez, por ejemplo.
  const methods = signInMethodsFor({
    hasPassword: user.passwordHash !== null,
    identityProviders: user.identities.map((i) => i.provider),
  });

  return (
    <Page>
      <PageHeader
        title="Ajustes"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Ajustes" }]}
      />

      <div className="nl-stagger grid gap-4">
        <Panel>
          <p className="nl-eyebrow mb-3">Cuenta</p>
          <dl className="grid gap-3 text-[0.9375rem]">
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Nombre</dt>
              <dd>{user.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Correo electrónico</dt>
              <dd className="truncate">{user.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Método de acceso</dt>
              <dd className="flex flex-wrap justify-end gap-1.5">
                {methods.map((method) => (
                  <Badge key={method} tone={method === "password" ? "neutral" : "violet"}>
                    {signInMethodLabel(method, "es")}
                  </Badge>
                ))}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Miembro desde</dt>
              <dd className="nl-num">{user.createdAt.toLocaleDateString("es-ES")}</dd>
            </div>
          </dl>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Tu página pública</p>
          <p className="nl-muted text-[0.9375rem]">
            Tu perfil está disponible en <span className="nl-num">/{promoter.slug}</span>. Este es el enlace para tu
            biografía de Instagram.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ButtonLink href={`/${promoter.slug}`} variant="quiet">
              <Icon name="link" size={17} />
              Abrir
            </ButtonLink>
            <ButtonLink href="/promoter/profile" variant="ghost">
              Editar
            </ButtonLink>
          </div>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Accesos rápidos</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/promoter/clubs" variant="quiet">
              <Icon name="users" size={17} />
              Discotecas
            </ButtonLink>
            <ButtonLink href="/promoter/subscription" variant="quiet">
              <Icon name="card" size={17} />
              Plan
            </ButtonLink>
          </div>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Seguridad</p>
          <p className="nl-muted text-[0.9375rem]">
            El cambio de contraseña, el acceso con Google o Apple y la eliminación de la cuenta estarán disponibles con el nuevo
            sistema de acceso.
          </p>
          <div className="mt-3">
            <Badge tone="warn">Próximamente</Badge>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
