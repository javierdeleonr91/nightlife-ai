"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckMark, Icon } from "@/components/ui";

/**
 * Onboarding progresivo.
 *
 * Una pregunta por pantalla y una barra que avanza. La razón no es estética:
 * un formulario de doce campos en el móvil de alguien que está de pie en la
 * puerta de su club no se termina nunca. Con un campo por pantalla, sí.
 *
 * Todo lo que no sea imprescindible se puede saltar. El objetivo del
 * onboarding no es tener la ficha completa: es llegar a un link que funcione.
 */

type Mode = "club" | "promoter";

const CLUB_STEPS = ["Tu club", "Dónde estáis", "Cómo os escriben"] as const;
const PROMOTER_STEPS = ["Quién eres", "Tu link", "Tu club"] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [data, setData] = useState<Record<string, string>>({});

  const steps = mode === "club" ? CLUB_STEPS : PROMOTER_STEPS;
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setData((d) => ({ ...d, [key]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError(null);
    const isClub = mode === "club";

    const payload = isClub
      ? {
          name: data.name,
          city: data.city,
          address: data.address || undefined,
          instagram: data.instagram || undefined,
          whatsapp: data.whatsapp || undefined,
          minAge: data.minAge ? Number(data.minAge) : undefined,
        }
      : {
          displayName: data.displayName,
          slug: data.slug || undefined,
          city: data.city || undefined,
          instagram: data.instagram || undefined,
          whatsapp: data.whatsapp || undefined,
          clubSlug: data.clubSlug || undefined,
        };

    try {
      const response = await fetch(isClub ? "/api/v1/clubs" : "/api/v1/promoters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "No se ha podido crear");

      setDone(true);
      setTimeout(() => {
        router.push(isClub ? `/club/${result.slug}/events` : "/promoter/home");
        router.refresh();
      }, 1100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setBusy(false);
    }
  }

  function next() {
    setError(null);
    if (step < steps.length - 1) setStep(step + 1);
    else void submit();
  }

  // ── elección de camino ────────────────────────────────────────────
  if (!mode) {
    return (
      <Shell>
        <div className="nl-enter grid gap-6">
          <header className="grid gap-2">
            <p className="nl-eyebrow">Empecemos</p>
            <h1 className="nl-display nl-h1">¿Qué eres?</h1>
          </header>

          <div className="nl-stagger grid gap-3">
            <PathCard
              icon="bolt"
              title="Club o promotora"
              body="Quiero que respondan por mí y vender más entradas."
              onClick={() => setMode("club")}
            />
            <PathCard
              icon="link"
              title="Promoter o RRPP"
              body="Quiero mi link personal y que el bot conteste por mí."
              onClick={() => setMode("promoter")}
            />
          </div>
        </div>
      </Shell>
    );
  }

  // ── éxito ─────────────────────────────────────────────────────────
  if (done) {
    return (
      <Shell>
        <div className="grid gap-4 py-12 text-center">
          <span className="nl-success__ring">
            <CheckMark size={34} />
          </span>
          <h1 className="nl-display text-[1.75rem]">Listo</h1>
          <p className="nl-muted">
            {mode === "club" ? "Ahora importa tu primer evento." : "Tu link ya está en marcha."}
          </p>
        </div>
      </Shell>
    );
  }

  // ── pasos ─────────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="grid gap-6">
        <div className="nl-steps" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={steps.length}>
          {steps.map((label, i) => (
            <span
              key={label}
              className={`nl-step ${i < step ? "nl-step--done" : i === step ? "nl-step--current" : ""}`}
            />
          ))}
        </div>

        <header className="grid gap-2">
          <p className="nl-eyebrow">
            Paso {step + 1} de {steps.length}
          </p>
          <h1 className="nl-display nl-h2">{steps[step]}</h1>
        </header>

        <form
          key={step}
          className="nl-enter grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            next();
          }}
        >
          {mode === "club" && step === 0 ? (
            <Field label="Nombre del club" value={data.name ?? ""} onChange={set("name")} required autoFocus />
          ) : null}
          {mode === "club" && step === 1 ? (
            <>
              <Field label="Ciudad" value={data.city ?? ""} onChange={set("city")} required autoFocus />
              <Field label="Dirección" hint="Opcional. Con esto el bot ya sabe responder «¿dónde estáis?»." value={data.address ?? ""} onChange={set("address")} />
              <Field label="Edad mínima" hint="Opcional." inputMode="numeric" value={data.minAge ?? ""} onChange={set("minAge")} />
            </>
          ) : null}
          {mode === "club" && step === 2 ? (
            <>
              <Field label="Instagram" hint="Opcional." value={data.instagram ?? ""} onChange={set("instagram")} autoFocus />
              <Field label="WhatsApp" hint="Opcional." inputMode="tel" value={data.whatsapp ?? ""} onChange={set("whatsapp")} />
            </>
          ) : null}

          {mode === "promoter" && step === 0 ? (
            <>
              <Field label="Tu nombre" value={data.displayName ?? ""} onChange={set("displayName")} required autoFocus />
              <Field label="Ciudad" hint="Opcional." value={data.city ?? ""} onChange={set("city")} />
            </>
          ) : null}
          {mode === "promoter" && step === 1 ? (
            <>
              <Field
                label="Tu link"
                hint="Es lo que pegarás en tu bio. Déjalo vacío y lo generamos con tu nombre."
                prefix="/"
                mono
                value={data.slug ?? ""}
                onChange={set("slug")}
                autoFocus
              />
              <Field label="Instagram" hint="Opcional." value={data.instagram ?? ""} onChange={set("instagram")} />
              <Field label="WhatsApp" hint="Opcional." inputMode="tel" value={data.whatsapp ?? ""} onChange={set("whatsapp")} />
            </>
          ) : null}
          {mode === "promoter" && step === 2 ? (
            <Field
              label="Identificador del club"
              hint="Opcional. Le llegará tu solicitud; hasta que la apruebe no verás sus eventos."
              mono
              value={data.clubSlug ?? ""}
              onChange={set("clubSlug")}
              autoFocus
            />
          ) : null}

          {error ? <p className="nl-error">{error}</p> : null}

          <div className="mt-2 flex gap-2">
            <button type="submit" disabled={busy} className="nl-btn nl-btn--hot nl-btn--block nl-btn--lg">
              {busy ? <span className="nl-spinner" /> : null}
              {step < steps.length - 1 ? "Continuar" : busy ? "Creando" : "Crear"}
            </button>
            <button
              type="button"
              className="nl-btn nl-btn--ghost"
              onClick={() => (step === 0 ? setMode(null) : setStep(step - 1))}
              disabled={busy}
            >
              Atrás
            </button>
          </div>
        </form>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="nl-app grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function PathCard({
  icon,
  title,
  body,
  onClick,
}: {
  icon: "bolt" | "link";
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="nl-card nl-card--interactive p-5 text-left">
      <span className="nl-empty__glyph mb-3" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <span className="nl-h3 block">{title}</span>
      <span className="nl-muted mt-1 block text-[0.9375rem]">{body}</span>
    </button>
  );
}

function Field({
  label,
  hint,
  prefix,
  mono,
  ...input
}: {
  label: string;
  hint?: string;
  prefix?: string;
  mono?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="nl-field">
      <label className="nl-label" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        {prefix ? <span className="nl-dim text-[1.125rem]">{prefix}</span> : null}
        <input id={id} className={`nl-input ${mono ? "nl-input--mono" : ""}`} {...input} />
      </div>
      {hint ? <p className="nl-hint">{hint}</p> : null}
    </div>
  );
}
