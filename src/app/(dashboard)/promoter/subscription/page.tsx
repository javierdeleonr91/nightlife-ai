import { redirect } from "next/navigation";
import { formatMoney, money } from "@nightlife/core/money";
import { PLANS, planByCode } from "@nightlife/core/billing";
import { getSubscriptionState } from "@nightlife/db";
import { requirePrincipal } from "@/lib/session";

/**
 * Suscripción del promoter.
 *
 * Lo que se paga aquí es el software. La plataforma no cobra entradas, no
 * cobra comisión sobre lo que venda el promoter y no le paga nada: el dinero
 * de las entradas va de cliente a Fourvenues y no pasa por nosotros en ningún
 * momento.
 *
 * El alta de pago llega en Fase 5 con Stripe. Esta pantalla ya muestra el
 * estado real y los planes para que el modelo comercial esté visible desde el
 * principio.
 */

export const dynamic = "force-dynamic";

const FEATURE_LABEL: Record<string, string> = {
  public_link: "Link personal público",
  event_selection: "Selección de eventos",
  branding: "Personalización de marca",
  ai_assistant: "Asistente que responde por ti",
  vip_module: "Módulo VIP",
  human_handoff: "Paso a persona",
  whatsapp_channel: "WhatsApp",
  instagram_channel: "Instagram",
  follow_ups: "Recordatorios sugeridos",
  multi_club: "Varios clubs",
  white_label: "Marca blanca",
};

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "En prueba",
  ACTIVE: "Activa",
  PAST_DUE: "Pago pendiente",
  CANCELED: "Cancelada",
};

export default async function PromoterSubscriptionPage() {
  const principal = await requirePrincipal();
  if (!principal.promoterId) redirect("/onboarding");

  const state = await getSubscriptionState("PROMOTER", principal.promoterId);
  const current = state ? planByCode(state.planCode) : null;
  const plans = PLANS.filter((p) => p.audience === "PROMOTER");

  return (
    <main className="mx-auto w-full max-w-md space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">Suscripción</h1>
        <p className="text-sm text-dash-muted">
          Pagas por la herramienta. Las entradas las cobra Fourvenues y ese dinero no pasa por
          nosotros.
        </p>
      </header>

      {state ? (
        <div className="rounded-xl border border-dash-line bg-dash-surface p-4">
          <p className="text-[11px] uppercase tracking-wide text-dash-muted">Plan actual</p>
          <p className="text-lg font-bold">{current?.name ?? state.planCode}</p>
          <p className="text-sm text-dash-muted">
            {STATUS_LABEL[state.status] ?? state.status}
            {state.trialEndsAt && state.status === "TRIALING"
              ? ` · hasta el ${state.trialEndsAt.toLocaleDateString("es-ES")}`
              : ""}
          </p>
        </div>
      ) : null}

      <section className="space-y-3">
        {plans.map((plan) => {
          const isCurrent = state?.planCode === plan.code;
          return (
            <article
              key={plan.code}
              className={`rounded-xl border p-4 ${
                isCurrent ? "border-dash-accent bg-dash-surface" : "border-dash-line bg-dash-surface"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-bold">{plan.name}</h2>
                <span className="font-bold tabular-nums">
                  {plan.priceCents === 0 ? "Gratis" : `${formatMoney(money(plan.priceCents))}/mes`}
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-dash-muted">
                {plan.features.map((feature) => (
                  <li key={feature}>· {FEATURE_LABEL[feature] ?? feature}</li>
                ))}
                {plan.limits.aiConversationsPerMonth > 0 ? (
                  <li>· {plan.limits.aiConversationsPerMonth.toLocaleString("es-ES")} conversaciones/mes</li>
                ) : null}
              </ul>
              {isCurrent ? (
                <p className="mt-3 text-xs font-semibold text-dash-accent">Tu plan actual</p>
              ) : (
                <p className="mt-3 text-xs text-dash-muted">
                  El cambio de plan se activará cuando conectemos el pago.
                </p>
              )}
            </article>
          );
        })}
      </section>

      <p className="text-xs text-dash-muted">
        No cobramos comisión por entrada ni gestionamos pagos entre clubs y promoters. Si necesitas
        saber cuántas entradas has movido, esa información está en Fourvenues o te la da tu club.
      </p>
    </main>
  );
}
