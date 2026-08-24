"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { useToast } from "@/components/toast";
import { INVITE_CODE_LENGTH, looksLikeInviteCode, normalizeInviteCode } from "@nightlife/core/invite";

/**
 * Entrar en un club con un código (§16).
 *
 * El campo normaliza mientras escribes: mayúsculas, sin guiones, y las
 * confusiones típicas (0/O, 1/I/L) resueltas. Alguien que copia el código de
 * un WhatsApp con un guion en medio no debería ver un error.
 *
 * El botón no se habilita hasta que el código tiene forma de código. Mandar
 * una petición que se sabe que va a fallar solo sirve para enseñar un error.
 */
export function JoinClub({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(!compact);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const normalized = normalizeInviteCode(code);
  const valid = looksLikeInviteCode(normalized);
  const problem = normalized.length >= INVITE_CODE_LENGTH && !valid;

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;

    setBusy(true);
    try {
      const response = await fetch("/api/v1/promoters/me/clubs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        // El mensaje viene del servidor y ya está redactado para leerse.
        toast.error(data?.error?.message ?? "We couldn't use that code.");
        return;
      }

      toast.ok(
        data.alreadyMember
          ? `You're already with ${data.club.name}`
          : `You're in — welcome to ${data.club.name}`,
      );
      setCode("");
      router.refresh();
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (compact && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="nl-btn nl-btn--quiet">
        <Icon name="plus" size={17} />
        Añadir una discoteca
      </button>
    );
  }

  return (
    <form onSubmit={join} className="nl-card p-5">
      <p className="nl-eyebrow">Have an invite?</p>
      <p className="nl-display mt-1 text-[1.15rem]">Añadir una discoteca</p>
      <p className="nl-muted mt-2 text-[0.9375rem]">
        Pide a la discoteca su código de invitación. Cuando te unas, sus eventos aparecerán en la
        pestaña Eventos.
      </p>

      <div className="nl-field mt-4">
        <label className="nl-label" htmlFor="invite-code">
          Código de invitación
        </label>
        <input
          id="invite-code"
          className="nl-input nl-input--mono text-center text-[1.25rem] tracking-[0.28em]"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          aria-invalid={problem}
        />
        {problem ? (
          <p className="nl-error">That code doesn&apos;t look right. Check it and try again.</p>
        ) : (
          <p className="nl-hint">Eight characters. Dashes and spaces don&apos;t matter.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={!valid || busy} className="nl-btn nl-btn--hot">
          {busy ? <span className="nl-spinner" /> : null}
          {busy ? "Uniéndote…" : "Añadir discoteca"}
        </button>
        {compact ? (
          <button type="button" onClick={() => setOpen(false)} className="nl-btn nl-btn--ghost">
            Cancelar
          </button>
        ) : null}
      </div>
    </form>
  );
}
