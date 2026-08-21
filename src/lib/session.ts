import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, signSessionToken, verifySessionToken } from "@nightlife/auth";
import { loadPrincipal } from "@nightlife/db";
import { env } from "@nightlife/config/env";
import type { Principal } from "@nightlife/core/rbac";

/**
 * Sesión del servidor.
 *
 * Toda la superficie de autenticación que conoce el resto de la aplicación
 * son estas cuatro funciones. Sustituir el módulo por Auth.js el día que
 * hagan falta OAuth o magic links no obliga a tocar ningún handler.
 */

export async function createSession(user: { id: string; email: string }): Promise<void> {
  const token = await signSessionToken({ sub: user.id, email: user.email }, env().AUTH_SECRET);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    ...SESSION_COOKIE_OPTIONS,
    secure: env().NODE_ENV === "production",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getPrincipal(): Promise<Principal | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token, env().AUTH_SECRET);
  if (!claims) return null;
  return loadPrincipal(claims.sub);
}

export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  return principal;
}
