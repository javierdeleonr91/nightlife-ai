import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { storageConfigured } from "@/lib/storage";
import { Page, PageHeader } from "@/components/app-shell";
import { ButtonLink, Icon, Panel } from "@/components/ui";
import { SettingsForm, type FieldSpec } from "@/components/settings-form";
import { ImageUpload } from "@/components/image-upload";
import { VisibilityToggles } from "@/components/visibility-toggles";

/**
 * Editar perfil (§6, §7).
 *
 * Cuatro bloques, no un formulario de catorce campos: **Profile**, **Social**,
 * **Public profile** y **Sales**. Cada bloque guarda por su cuenta, así que
 * cambiar la bio no obliga a pasar por delante del slug — que es el campo más
 * peligroso de esta pantalla, porque cambiarlo rompe todos los enlaces que ya
 * circulan.
 *
 * Los dos enlaces del promoter, separados a propósito: el de **Public profile**
 * es su página aquí; el de **Sales** es su enlace de Fourvenues, que vive en
 * Integrations y aquí solo se menciona con un acceso directo. Mezclarlos era la
 * confusión número uno del producto.
 */

export const dynamic = "force-dynamic";

export default async function PromoterProfilePage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const promoter = await prisma.promoter.findUnique({ where: { id: principal.promoterId } });
  if (!promoter) redirect("/onboarding");

  const uploads = storageConfigured();

  /*
   * Valores iniciales campo a campo, no el modelo entero: `createdAt`,
   * `updatedAt` y los booleanos de visibilidad no son campos de estos
   * formularios, y colarlos aquí solo funcionaba porque nadie lo comprobaba.
   */
  const profile = {
    displayName: promoter.displayName,
    bio: promoter.bio,
    city: promoter.city,
    ...(uploads ? {} : { photoUrl: promoter.photoUrl, coverImageUrl: promoter.coverImageUrl }),
  };

  const social = {
    instagram: promoter.instagram,
    whatsapp: promoter.whatsapp,
  };

  const publicProfile = { slug: promoter.slug };

  /*
   * Sin subida configurada, estos dos campos vuelven como texto para poder
   * pegar una URL. Se declaran con su tipo en vez de con `as const`: una tupla
   * readonly no encaja donde se espera un FieldSpec[].
   */
  const profileFields: FieldSpec[] = [
    {
      name: "displayName",
      label: "Nombre público",
      required: true,
      maxLength: 60,
      hint: "El nombre que aparece en tu página pública. No tiene por qué ser tu nombre legal.",
    },
    {
      name: "bio",
      label: "Bio corta",
      kind: "textarea",
      maxLength: 280,
      hint: "Dos líneas. La gente lo leerá desde el móvil en cuestión de segundos.",
    },
    { name: "city", label: "Ciudad", maxLength: 60 },
  ];

  if (!uploads) {
    profileFields.push(
      { name: "photoUrl", label: "URL de la foto", kind: "url" },
      { name: "coverImageUrl", label: "URL de la portada", kind: "url" },
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Esto es lo que verá la gente"
        title="Editar perfil"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Perfil" }]}
        action={
          <ButtonLink href={`/${promoter.slug}`} variant="quiet" external>
            <Icon name="eye" size={17} />
            Vista previa
          </ButtonLink>
        }
      />

      <div className="nl-stagger grid gap-4">
        {/* ── PROFILE ─────────────────────────────────────────────── */}
        <Panel>
          <p className="nl-eyebrow mb-4">Perfil</p>

          <div className="grid gap-5">
            <ImageUpload
              variant="avatar"
              slot="avatar"
              endpoint="/api/v1/promoters/me/media"
              current={promoter.photoUrl}
              label="Foto de perfil"
              name={promoter.displayName}
              configured={uploads}
            />

            <ImageUpload
              variant="cover"
              slot="cover"
              endpoint="/api/v1/promoters/me/media"
              current={promoter.coverImageUrl}
              label="Portada"
              name={promoter.displayName}
              configured={uploads}
            />

            <SettingsForm
              action="/api/v1/promoters/me"
              fields={profileFields}
              initial={profile}
            />
          </div>
        </Panel>

        {/* ── SOCIAL ──────────────────────────────────────────────── */}
        <Panel>
          <p className="nl-eyebrow mb-4">Redes sociales</p>
          <SettingsForm
            action="/api/v1/promoters/me"
            fields={[
              { name: "instagram", label: "Instagram", prefix: "@", maxLength: 60 },
              { name: "whatsapp", label: "WhatsApp", kind: "tel", placeholder: "+34 600 000 000" },
            ]}
            initial={social}
          />
        </Panel>

        {/* ── PUBLIC PROFILE ──────────────────────────────────────── */}
        <Panel>
          <p className="nl-eyebrow mb-2">Perfil público</p>
          <p className="nl-muted mb-4 text-[0.9375rem]">
            Cambiar tu enlace hará que dejen de funcionar los que ya hayas compartido. Cámbialo solo si
            es necesario.
          </p>
          <SettingsForm
            action="/api/v1/promoters/me"
            fields={[
              {
                name: "slug",
                label: "Enlace",
                prefix: "/",
                mono: true,
                maxLength: 48,
                hint: "Letras minúsculas, números y guiones.",
              },
            ]}
            initial={publicProfile}
          />

          <div className="mt-6">
            <p className="nl-eyebrow mb-1">Visibilidad</p>
            <p className="nl-hint mb-2">Tú decides qué aparece en tu página pública.</p>
            <VisibilityToggles
              fields={[
                {
                  name: "showInstagram",
                  label: "Instagram",
                  value: promoter.showInstagram,
                  available: Boolean(promoter.instagram),
                },
                {
                  name: "showWhatsapp",
                  label: "WhatsApp",
                  hint: "Esto publica tu número de teléfono.",
                  value: promoter.showWhatsapp,
                  available: Boolean(promoter.whatsapp),
                },
                {
                  name: "showCity",
                  label: "Ciudad",
                  value: promoter.showCity,
                  available: Boolean(promoter.city),
                },
              ]}
            />
          </div>
        </Panel>

        {/* ── SALES ───────────────────────────────────────────────── */}
        <Panel>
          <p className="nl-eyebrow mb-2">Ventas</p>
          <p className="nl-muted text-[0.9375rem]">
            Tu enlace de ventas de Fourvenues —el que ya utilizas para vender— se gestiona en Integraciones.
            Es diferente del enlace de perfil público que aparece arriba.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ButtonLink href="/promoter/integrations" variant="quiet">
              <Icon name="plug" size={17} />
              {promoter.fourvenuesUrl ? "Gestionar enlace de ventas" : "Añadir enlace de ventas"}
            </ButtonLink>
            <span className={promoter.fourvenuesUrl ? "nl-badge nl-badge--live" : "nl-badge nl-badge--warn"}>
              {promoter.fourvenuesUrl ? "Conectado" : "Sin configurar"}
            </span>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
