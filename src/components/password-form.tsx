"use client";

import { useState } from "react";
import { t, type Locale } from "@nightlife/core/i18n";

/**
 * Email y contraseña, para entrar y para registrarse.
 *
 * Un componente para los dos casos porque solo cambian el endpoint, un campo y
 * las etiquetas. Dos ficheros casi iguales acaban divergiendo en el manejo de
 * errores, que es justo lo que no puede divergir.
 *
 * El error del servidor se enseña tal cual llega: las rutas de auth ya
 * devuelven mensajes redactados para leerse. Y es deliberadamente el mismo para
 * «no existe ese email» y «la contraseña no vale»: distinguirlos le diría a
 * cualquiera qué correos están registrados.
 */
export function PasswordForm({
  mode,
  locale,
  error: initialError,
  next,
}: {
  mode: "signin" | "register";
  locale: Locale;
  error?: string | null;
  next?: string | null;
}) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    if (isRegister) body.name = String(form.get("name") ?? "");

    try {
      const response = await fetch(isRegister ? "/api/v1/auth/register" : "/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setError(data?.error?.message ?? t("badCredentials", locale));
        return;
      }

      // Navegación dura, igual que en el logout: así el árbol de servidor se
      // evalúa entero con la sesión nueva y no queda nada de la caché anterior.
      window.location.assign(next && next.startsWith("/") ? next : "/");
    } catch {
      setError(t("genericError", locale));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      {isRegister ? (
        <div className="nl-field">
          <label className="nl-label" htmlFor="name">
            {t("name", locale)}
          </label>
          <input
            id="name"
            name="name"
            required
            autoComplete="name"
            maxLength={80}
            className="nl-input"
          />
        </div>
      ) : null}

      <div className="nl-field">
        <label className="nl-label" htmlFor="email">
          {t("email", locale)}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          className="nl-input"
        />
      </div>

      <div className="nl-field">
        <label className="nl-label" htmlFor="password">
          {t("password", locale)}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={isRegister ? "new-password" : "current-password"}
          className="nl-input"
        />
      </div>

      {error ? <p className="nl-error">{error}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="nl-btn nl-btn--hot nl-btn--block nl-btn--lg mt-1"
      >
        {busy ? <span className="nl-spinner" /> : null}
        {busy
          ? t(isRegister ? "creatingAccount" : "signingIn", locale)
          : t(isRegister ? "createAccount" : "signIn", locale)}
      </button>
    </form>
  );
}
