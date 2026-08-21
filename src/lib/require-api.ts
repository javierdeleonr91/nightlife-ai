import { AppError } from "@nightlife/core/errors";
import type { Principal } from "@nightlife/core/rbac";
import { getPrincipal } from "./session";

/** Igual que requirePrincipal pero lanzando 401 en vez de redirigir: los
 *  endpoints de API no deben responder con un HTML de login. */
export async function requirePrincipalApi(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) throw AppError.unauthenticated();
  return principal;
}
