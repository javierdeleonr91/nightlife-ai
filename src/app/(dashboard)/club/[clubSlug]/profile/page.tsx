import { Page, PageHeader } from "@/components/app-shell";
import { ButtonLink, Icon, Panel } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { requireClubPage } from "@/lib/club-page";

export const dynamic = "force-dynamic";

export default async function ClubProfilePage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { club, base } = await requireClubPage(clubSlug, "club:read");

  /*
   * Los valores iniciales se declaran campo a campo.
   *
   * Pasar el modelo de Prisma entero parecía cómodo y era un error: arrastra
   * `brand`, `createdAt`, `updatedAt` y las relaciones, que no son valores de
   * formulario. Escribirlos aquí obliga a que cada formulario diga exactamente
   * qué edita, y el compilador comprueba que los nombres existen.
   */
  const basics = {
    name: club.name,
    city: club.city,
    description: club.description,
    address: club.address,
  };

  const contact = {
    whatsapp: club.whatsapp,
    instagram: club.instagram,
    website: club.website,
  };

  const door = {
    minAge: club.minAge,
    openingHours: club.openingHours,
    dressCode: club.dressCode,
  };

  return (
    <Page>
      <PageHeader
        eyebrow={club.city}
        title="Perfil"
        back={{ href: `${base}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `${base}/overview` }, { label: "Perfil" }]}
        action={
          <ButtonLink href={`/c/${club.slug}`} variant="quiet">
            <Icon name="link" size={17} />
            Ver página pública
          </ButtonLink>
        }
      />

      <div className="nl-stagger grid gap-4">
        <Panel>
          <p className="nl-eyebrow mb-4">Información básica</p>
          <SettingsForm
            action={`/api/v1/clubs/${club.id}`}
            fields={[
              { name: "name", label: "Nombre del club", required: true },
              { name: "city", label: "Ciudad", required: true },
              { name: "description", label: "Descripción corta", kind: "textarea" },
              { name: "address", label: "Dirección", hint: "El asistente utiliza esta dirección cuando le preguntan dónde está el club." },
            ]}
            initial={basics}
          />
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-4">Contacto</p>
          <SettingsForm
            action={`/api/v1/clubs/${club.id}`}
            fields={[
              { name: "whatsapp", label: "WhatsApp", kind: "tel", placeholder: "+34 600 000 000" },
              { name: "instagram", label: "Instagram", prefix: "@" },
              { name: "website", label: "Sitio web", kind: "url" },
            ]}
            initial={contact}
          />
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-4">Condiciones de acceso</p>
          <p className="nl-hint mb-4">
            El asistente responderá usando exactamente esta información. Si dejas un campo vacío,
            dirá que no puede confirmarlo en lugar de inventar una respuesta.
          </p>
          <SettingsForm
            action={`/api/v1/clubs/${club.id}`}
            fields={[
              { name: "minAge", label: "Edad mínima", kind: "number", placeholder: "18" },
              { name: "openingHours", label: "Horario de apertura", placeholder: "Vie y sáb, 00:00–06:00" },
              { name: "dressCode", label: "Código de vestimenta", kind: "textarea" },
            ]}
            initial={door}
          />
        </Panel>
      </div>
    </Page>
  );
}
