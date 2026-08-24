import { Page, PageHeader } from "@/components/app-shell";
import { Badge, Icon, Panel } from "@/components/ui";
import { FourvenuesConnect } from "@/components/fourvenues-connect";
import { requireClubPage } from "@/lib/club-page";
import { getIntegration, unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { withOwnerRls } from "@nightlife/db/owner";

/**
 * Integraciones (§24).
 *
 * Fourvenues enseña su estado real y es la única que se puede conectar hoy.
 * Instagram y WhatsApp dicen lo que son — «Setup required» — y **no fingen
 * funcionar**: un botón «Connect» que no conecta nada es peor que no tener el
 * botón, porque quema la confianza justo en la pantalla donde el club decide
 * si esto es serio.
 */

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { club, base } = await requireClubPage(clubSlug, "club:read");

  const [integration, eventCount] = await Promise.all([
    getIntegration(club.id),
    withOwnerRls({ type: "CLUB", clubId: club.id }, (tx) =>
      tx.event.count({ where: { clubId: club.id, status: { not: "ENDED" } } }),
    ),
  ]);

  const connected = integration?.status === "CONNECTED";
  const lastSync = integration?.lastSyncedAt ?? null;
  const minutesAgo = lastSync ? Math.round((Date.now() - lastSync.getTime()) / 60000) : null;

  return (
    <Page>
      <PageHeader
        eyebrow={club.name}
        title="Integraciones"
        back={{ href: `${base}/overview`, label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: `${base}/overview` }, { label: "Integraciones" }]}
      />

      <FourvenuesConnect
        clubId={club.id}
        connected={connected}
        keyHint={integration?.keyHint ?? null}
        channelName={integration?.channelName ?? null}
      />

      {connected ? (
        <p className="nl-dim mt-3 text-[0.8125rem]">
          {eventCount} {eventCount === 1 ? "evento" : "eventos"} en tu cuenta
          {minutesAgo !== null
            ? ` · última sincronización ${minutesAgo < 1 ? "ahora mismo" : `hace ${minutesAgo} min`}`
            : ""}
        </p>
      ) : null}

      {integration?.status === "INVALID_KEY" ? (
        <p className="nl-error mt-3">
          Fourvenues ha rechazado tu clave. Puede que haya sido revocada; crea una nueva y vuelve a conectar.
        </p>
      ) : null}

      {/* Honestidad por delante: estos dos no existen todavía y se dice. */}
      <p className="nl-eyebrow mb-3 mt-8">Canales de mensajería</p>
      <div className="nl-stagger grid gap-3">
        {[
          {
            name: "Chat web",
            note: "El asistente de tu página pública. Disponible actualmente.",
            ready: true,
          },
          {
            name: "Mensajes de Instagram",
            note: "El mismo asistente respondiendo tus mensajes. Requiere que la app de Meta esté aprobada.",
            ready: false,
          },
          {
            name: "WhatsApp",
            note: "El mismo asistente en la API oficial de WhatsApp Business. Requiere que la app de Meta esté aprobada.",
            ready: false,
          },
        ].map((channel) => (
          <div
            key={channel.name}
            className="nl-integration"
            style={channel.ready ? undefined : { opacity: 0.72 }}
          >
            <span className="nl-integration__logo" aria-hidden="true">
              <Icon name="chat" size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{channel.name}</p>
              <p className="nl-dim text-[0.8125rem]">{channel.note}</p>
            </div>
            {channel.ready ? (
              <Badge tone="live" dot pulse>
                Activo
              </Badge>
            ) : (
              <Badge tone="warn">Configuración pendiente</Badge>
            )}
          </div>
        ))}
      </div>

      <Panel className="mt-6">
        <p className="nl-eyebrow mb-2">Un asistente, todos los canales</p>
        <p className="nl-muted text-[0.9375rem]">
          El chat web, Instagram y WhatsApp utilizan el mismo motor, por lo que la información sobre tus
          eventos, precios y condiciones de acceso es la misma en todos los canales. Instagram y WhatsApp están
          desactivados hasta que Meta apruebe la app; mientras tanto no simulamos una conexión que todavía no existe.
        </p>
      </Panel>
    </Page>
  );
}
