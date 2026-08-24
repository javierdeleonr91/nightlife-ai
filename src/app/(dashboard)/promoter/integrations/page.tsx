import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, Icon, Panel } from "@/components/ui";
import { PromoterFourvenuesLink } from "@/components/promoter-fourvenues-link";

/**
 * Integraciones del promoter (§14).
 *
 * La diferencia con el club es la regla más importante de esta pantalla: **al
 * RRPP no se le pide nunca una API Key**. Él ya tiene su enlace personal de
 * Fourvenues; lo pega y ya está. La API Key es de la organización, es del
 * club, y pedírsela a un RRPP sería pedirle una credencial que no le
 * pertenece.
 */

export const dynamic = "force-dynamic";

export default async function PromoterIntegrationsPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const promoter = await prisma.promoter.findUnique({
    where: { id: principal.promoterId },
    select: { fourvenuesUrl: true },
  });
  if (!promoter) redirect("/onboarding");

  return (
    <Page>
      <PageHeader
        eyebrow="Qué tienes conectado"
        title="Integraciones"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Integraciones" }]}
      />

      <PromoterFourvenuesLink initial={promoter.fourvenuesUrl} />

      <p className="nl-eyebrow mb-3 mt-8">Canales de mensajería</p>
      <div className="nl-stagger grid gap-3">
        {[
          { name: "Chat web", note: "El asistente de tu página pública.", ready: true },
          {
            name: "Mensajes de Instagram",
            note: "Responde tus mensajes con el mismo asistente. Pendiente de aprobación de Meta.",
            ready: false,
          },
          {
            name: "WhatsApp",
            note: "API oficial de WhatsApp Business. Pendiente de aprobación de Meta.",
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
        <p className="nl-eyebrow mb-2">Dos enlaces diferentes</p>
        <p className="nl-muted text-[0.9375rem]">
          Tu <strong>perfil público</strong> es tu página en esta plataforma: el enlace que puedes poner en
          tu biografía de Instagram. Tu <strong>enlace de ventas de Fourvenues</strong> es el que Fourvenues te dio
          para vender. La gente llega al primero y compra a través del segundo.
        </p>
      </Panel>
    </Page>
  );
}
