"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "No se ha podido crear la cuenta");
      router.push("/onboarding");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5">
      <h1 className="text-2xl font-bold">Crear cuenta</h1>
      <form onSubmit={submit} className="space-y-3">
        <input
          name="name"
          required
          autoComplete="name"
          placeholder="Nombre"
          className="w-full rounded-lg border border-dash-line bg-dash-surface px-3 py-2.5 text-sm"
        />
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          className="w-full rounded-lg border border-dash-line bg-dash-surface px-3 py-2.5 text-sm"
        />
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="Contraseña (mínimo 8 caracteres)"
          className="w-full rounded-lg border border-dash-line bg-dash-surface px-3 py-2.5 text-sm"
        />
        {error ? <p className="text-sm text-rose-500">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-dash-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Creando…" : "Crear cuenta"}
        </button>
      </form>
      <p className="text-sm text-dash-muted">
        ¿Ya tienes cuenta?{" "}
        <Link href="/login" className="underline underline-offset-4">
          Entrar
        </Link>
      </p>
    </main>
  );
}
