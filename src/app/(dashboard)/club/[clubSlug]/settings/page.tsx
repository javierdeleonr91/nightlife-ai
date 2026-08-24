import { Page, PageHeader } from "@/components/app-shell";
import { Badge, ButtonLink, Icon, Panel } from "@/components/ui";
import { requireClubPage } from "@/lib/club-page";
import { signInMethodLabel, signInMethodsFor } from "@nightlife/core/oauth";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ClubSettingsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { club, base } = await requireClubPage(clubSlug, "club:read");
  const principal = await requirePrincipal();
  const user = await prisma.user.findUnique({
    where: { id: principal.userId },
    select: {
      email: true,
      name: true,
      createdAt: true,
      passwordHash: true,
      identities: { select: { provider: true }, orderBy: { lastUsedAt: "desc" } },
    },
  });

  const role = principal.clubRoles.get(club.id);

  const methods = signInMethodsFor({
    hasPassword: user?.passwordHash != null,
    identityProviders: (user?.identities ?? []).map((i) => i.provider),
  });

  return (
    <Page>
      <PageHeader
        title="Ajustes"
        back={{ href: `${base}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `${base}/overview` }, { label: "Ajustes" }]}
      />

      <div className="nl-stagger grid gap-4">
        <Panel>
          <p className="nl-eyebrow mb-3">Cuenta</p>
          <dl className="grid gap-3 text-[0.9375rem]">
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Nombre</dt>
              <dd>{user?.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="nl-dim">Correo electrónico</dt>
              <dd className="truncate">{user?.email}</dd>
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
              <dt className="nl-dim">Rol</dt>
              <dd>
                <Badge tone="violet">{role === "CLUB_OWNER" ? "Propietario" : "Gestor"}</Badge>
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Página pública</p>
          <p className="nl-muted text-[0.9375rem]">
            Tu club está disponible en <span className="nl-num">/c/{club.slug}</span>. Este es el enlace que
            puedes poner en la biografía de Instagram.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ButtonLink href={`/c/${club.slug}`} variant="quiet">
              <Icon name="link" size={17} />
              Abrir
            </ButtonLink>
            <ButtonLink href={`${base}/branding`} variant="ghost">
              Personalizar
            </ButtonLink>
          </div>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Accesos rápidos</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`${base}/integrations`} variant="quiet">
              <Icon name="plug" size={17} />
              Integraciones
            </ButtonLink>
            <ButtonLink href={`${base}/subscription`} variant="quiet">
              <Icon name="card" size={17} />
              Plan
            </ButtonLink>
          </div>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-3">Seguridad</p>
          <p className="nl-muted text-[0.9375rem]">
            El cambio de contraseña, la verificación en dos pasos y la eliminación de la cuenta estarán disponibles próximamente.
          </p>
          <div className="mt-3">
            <Badge tone="warn">Próximamente</Badge>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
