import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { PLANS, planByCode } from "@nightlife/core/billing";
import { getSubscriptionState } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";
import { Page, PageHeader } from "@/components/app-shell";
import { Badge, CheckMark } from "@/components/ui";

/**
 * Suscripción del promoter.
 *
 * Lo que se paga aquí es el software. La plataforma no cobra entradas, no
 * cobra comisión sobre lo que venda el promoter y no le paga nada: el dinero
 * de las entradas va de cliente a Fourvenues y no pasa por nosotros en ningún
 * momento. Esa frase está también en la pantalla, no solo en el código:
 * alguien que viene del mundo de la afiliación necesita leerla.
 */

export const dynamic = "force-dynamic";

const FEATURE_LABEL: Record<string, string> = {
  public_link: "Tu propio enlace público",
  event_selection: "Elige qué eventos se muestran",
  branding: "Tus colores y tu foto",
  ai_assistant: "Asistente que responde por ti",
  vip_module: "Módulo VIP y reservados",
  human_handoff: "Pasar la conversación a una persona",
  whatsapp_channel: "WhatsApp",
  instagram_channel: "Instagram",
  follow_ups: "Seguimientos sugeridos",
  multi_club: "Varias discotecas",
  white_label: "Marca blanca",
};

const STATUS: Record<string, { label: string; tone: "live" | "warn" | "crit" }> = {
  TRIALING: { label: "Prueba", tone: "warn" },
  ACTIVE: { label: "Activo", tone: "live" },
  PAST_DUE: { label: "Pago pendiente", tone: "warn" },
  CANCELED: { label: "Cancelado", tone: "crit" },
};

export default async function PromoterSubscriptionPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const state = await getSubscriptionState("PROMOTER", principal.promoterId);
  const current = state ? planByCode(state.planCode) : null;
  const status = state ? (STATUS[state.status] ?? STATUS.ACTIVE!) : null;
  const plans = PLANS.filter((p) => p.audience === "PROMOTER");

  return (
    <Page>
      <PageHeader
        eyebrow="Pagas por la herramienta, no por cada entrada"
        title="Plan"
        back={{ href: "/promoter/home", label: "Inicio" }}
        crumbs={[{ label: "Inicio", href: "/promoter/home" }, { label: "Plan" }]}
      />

      {state && status ? (
        <div className="nl-card nl-enter mb-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="nl-eyebrow">Plan actual</p>
              <p className="nl-display mt-1 text-[1.5rem]">{current?.name ?? state.planCode}</p>
            </div>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          {state.trialEndsAt && state.status === "TRIALING" ? (
            <p className="nl-dim mt-2 text-[0.8125rem]">
              Tu periodo de prueba termina el {state.trialEndsAt.toLocaleDateString("es-ES")}.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="nl-stagger grid gap-3">
        {plans.map((plan) => {
          const isCurrent = state?.planCode === plan.code;
          return (
            <article
              key={plan.code}
              className="nl-card p-5"
              style={isCurrent ? { boxShadow: "var(--nl-glow-hot)" } : undefined}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="nl-h3">{plan.name}</h2>
                <span className="nl-price nl-price--md">
                  {plan.priceCents === 0 ? "Gratis" : formatMoney(money(plan.priceCents))}
                  {plan.priceCents > 0 ? (
                    <span className="nl-dim text-[0.75rem] font-normal"> /mes</span>
                  ) : null}
                </span>
              </div>

              <ul className="mt-3 grid gap-1.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-[0.9375rem]">
                    <span style={{ color: "var(--nl-live)" }}>
                      <CheckMark size={15} />
                    </span>
                    {FEATURE_LABEL[feature] ?? feature}
                  </li>
                ))}
                {plan.limits.aiConversationsPerMonth > 0 ? (
                  <li className="nl-muted flex items-center gap-2 text-[0.9375rem]">
                    <span style={{ color: "var(--nl-live)" }}>
                      <CheckMark size={15} />
                    </span>
                    {plan.limits.aiConversationsPerMonth.toLocaleString("es-ES")} conversaciones al
                    mes
                  </li>
                ) : null}
              </ul>

              <p className="nl-hint mt-4">
                {isCurrent ? "Este es tu plan actual." : "Los cambios de plan estarán disponibles cuando se active la facturación."}
              </p>
            </article>
          );
        })}
      </div>

      <p className="nl-dim mt-6 text-[0.8125rem]">
        No cobramos comisión por entrada ni movemos dinero entre discotecas y RRPP. Si necesitas
        consultar cuántas entradas has vendido, esa información está en Fourvenues o en tu discoteca.
      </p>
    </Page>
  );
}
