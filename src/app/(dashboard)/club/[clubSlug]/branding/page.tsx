import { Page, PageHeader } from "@/components/app-shell";
import { ButtonLink, Icon, Panel } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { ImageUpload } from "@/components/image-upload";
import { requireClubPage } from "@/lib/club-page";
import { storageConfigured } from "@/lib/storage";
import { THEME_ACCENT, THEME_BACKGROUND, THEME_TEXT } from "@/design/theme";

export const dynamic = "force-dynamic";

export default async function BrandingPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const { club, base } = await requireClubPage(clubSlug, "club:branding");
  const brand = club.brand;

  const accent = brand?.primaryColor ?? THEME_ACCENT;
  const background = brand?.backgroundColor ?? THEME_BACKGROUND;
  const text = brand?.textColor ?? THEME_TEXT;
  const uploads = storageConfigured();

  return (
    <Page>
      <PageHeader
        eyebrow={club.name}
        title="Marca"
        back={{ href: `${base}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `${base}/overview` }, { label: "Marca" }]}
        action={
          <ButtonLink href={`/c/${club.slug}`} variant="quiet">
            <Icon name="link" size={17} />
            Vista previa
          </ButtonLink>
        }
      />

      <div className="nl-stagger grid gap-4">
        {/* La vista previa usa los mismos valores que la página pública, así
            que lo que se ve aquí es lo que verá un cliente. */}
        <div
          className="nl-card grid place-items-center gap-3 p-9 text-center"
          style={{
            background: `radial-gradient(90% 60% at 50% 0%, ${accent}33, transparent 70%), ${background}`,
            color: text,
          }}
        >
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo del club
            <img src={brand.logoUrl} alt="" className="h-14 w-auto object-contain" />
          ) : (
            <p className="nl-display text-[1.75rem]">{club.name}</p>
          )}
          <span
            className="nl-btn"
            style={{ background: accent, color: background, boxShadow: "none" }}
          >
            Comprar entradas
          </span>
          <p className="text-[0.8125rem]" style={{ color: `${text}88` }}>
            Así se ve tu página ahora mismo.
          </p>
        </div>

        <Panel>
          <p className="nl-eyebrow mb-4">Colores</p>
          <SettingsForm
            action={`/api/v1/clubs/${club.id}/branding`}
            fields={[
              { name: "primaryColor", label: "Color principal", kind: "color", hint: "Se usa en botones y elementos destacados. Ajustamos el contraste para que el texto siga siendo legible.", fallback: THEME_ACCENT },
              { name: "backgroundColor", label: "Fondo", kind: "color", fallback: THEME_BACKGROUND },
              { name: "textColor", label: "Texto", kind: "color", fallback: THEME_TEXT },
            ]}
            initial={{
              primaryColor: accent,
              backgroundColor: background,
              textColor: text,
            }}
          />
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-4">Imágenes</p>
          <div className="grid gap-5">
            <ImageUpload
              variant="avatar"
              slot="logo"
              endpoint={`/api/v1/clubs/${club.id}/media`}
              current={brand?.logoUrl ?? null}
              label="Logo"
              name={club.name}
              configured={uploads}
            />
            <ImageUpload
              variant="cover"
              slot="cover"
              endpoint={`/api/v1/clubs/${club.id}/media`}
              current={brand?.coverImageUrl ?? null}
              label="Portada"
              name={club.name}
              configured={uploads}
            />
            {uploads ? null : (
              <SettingsForm
                action={`/api/v1/clubs/${club.id}/branding`}
                fields={[
                  { name: "logoUrl", label: "URL del logo", kind: "url", mono: true },
                  { name: "coverImageUrl", label: "URL de la portada", kind: "url", mono: true },
                ]}
                initial={{ logoUrl: brand?.logoUrl, coverImageUrl: brand?.coverImageUrl }}
              />
            )}
          </div>
        </Panel>

        <Panel>
          <p className="nl-eyebrow mb-4">Estilo</p>
          <SettingsForm
            action={`/api/v1/clubs/${club.id}/branding`}
            fields={[
              { name: "borderRadius", label: "Redondeado de esquinas", kind: "number", hint: "0 para esquinas rectas, 22 para un acabado más redondeado." },
              { name: "fontFamily", label: "Tipografía", hint: "Puedes usar una tipografía disponible en el dispositivo. Las tipografías personalizadas llegarán más adelante." },
            ]}
            initial={{ borderRadius: brand?.borderRadius ?? 22, fontFamily: brand?.fontFamily ?? "Inter" }}
          />
        </Panel>
      </div>
    </Page>
  );
}
