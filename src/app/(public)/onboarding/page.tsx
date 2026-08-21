"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Onboarding. Dos caminos, una pantalla cada uno, y el mínimo de campos que
 * hacen falta para que el link público tenga sentido. Todo lo demás se
 * configura después: obligar a rellenar quince campos aquí es la forma más
 * fiable de que un club no termine nunca el alta.
 */

const inputClass =
  "w-full rounded-lg border border-dash-line bg-dash-surface px-3 py-2.5 text-sm";

export default function OnboardingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"club" | "promoter" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const isClub = mode === "club";

    const payload = isClub
      ? {
          name: form.get("name"),
          city: form.get("city"),
          instagram: form.get("instagram") || undefined,
          whatsapp: form.get("whatsapp") || undefined,
          address: form.get("address") || undefined,
          minAge: form.get("minAge") ? Number(form.get("minAge")) : undefined,
        }
      : {
          displayName: form.get("displayName"),
          city: form.get("city") || undefined,
          instagram: form.get("instagram") || undefined,
          whatsapp: form.get("whatsapp") || undefined,
          clubSlug: form.get("clubSlug") || undefined,
        };

    try {
      const response = await fetch(isClub ? "/api/v1/clubs" : "/api/v1/promoters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "No se ha podido crear");
      router.push(isClub ? `/club/${data.slug}/events` : "/promoter/home");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  if (!mode) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5">
        <h1 className="text-2xl font-bold">¿Qué eres?</h1>
        <button
          type="button"
          onClick={() => setMode("club")}
          className="rounded-xl border border-dash-line bg-dash-surface p-5 text-left"
        >
          <span className="block font-semibold">Club o promotora</span>
          <span className="text-sm text-dash-muted">
            Quiero que respondan por mí y vender más entradas.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setMode("promoter")}
          className="rounded-xl border border-dash-line bg-dash-surface p-5 text-left"
        >
          <span className="block font-semibold">Promoter o RRPP</span>
          <span className="text-sm text-dash-muted">
            Quiero mi link personal y que el bot conteste por mí.
          </span>
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5 py-10">
      <h1 className="text-2xl font-bold">{mode === "club" ? "Tu club" : "Tu perfil"}</h1>

      <form onSubmit={submit} className="space-y-3">
        {mode === "club" ? (
          <>
            <input name="name" required placeholder="Nombre del club" className={inputClass} />
            <input name="city" required placeholder="Ciudad" className={inputClass} />
            <input name="address" placeholder="Dirección (opcional)" className={inputClass} />
            <input name="instagram" placeholder="Instagram (opcional)" className={inputClass} />
            <input name="whatsapp" placeholder="WhatsApp (opcional)" className={inputClass} />
            <input
              name="minAge"
              type="number"
              min={16}
              max={30}
              placeholder="Edad mínima (opcional)"
              className={inputClass}
            />
            <p className="text-xs text-dash-muted">
              Con la dirección y la edad mínima creamos ya dos respuestas automáticas. El resto lo
              configuras luego.
            </p>
          </>
        ) : (
          <>
            <input name="displayName" required placeholder="Tu nombre" className={inputClass} />
            <input name="city" placeholder="Ciudad (opcional)" className={inputClass} />
            <input name="instagram" placeholder="Instagram (opcional)" className={inputClass} />
            <input name="whatsapp" placeholder="WhatsApp (opcional)" className={inputClass} />
            <input
              name="clubSlug"
              placeholder="Identificador del club (opcional)"
              className={inputClass}
            />
            <p className="text-xs text-dash-muted">
              Si pones un club, le llegará tu solicitud. Hasta que la apruebe no aparecerán sus
              eventos en tu link.
            </p>
          </>
        )}

        {error ? <p className="text-sm text-rose-500">{error}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-dash-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Creando…" : "Continuar"}
        </button>
        <button
          type="button"
          onClick={() => setMode(null)}
          className="w-full text-sm text-dash-muted underline underline-offset-4"
        >
          Volver
        </button>
      </form>
    </main>
  );
}
