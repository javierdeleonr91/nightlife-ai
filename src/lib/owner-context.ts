import { AppError } from "@nightlife/core/errors";
import type { Principal } from "@nightlife/core/rbac";
import { forOwner, type Owner } from "@nightlife/db/owner";

/**
 * De qué dueño es esta petición.
 *
 * El punto entero de este archivo es que el `owner` NO llegue nunca del
 * cliente. Una ruta de club lo saca del slug de la URL y comprueba la
 * pertenencia; una ruta de RRPP lo saca del Principal y punto. Si un body
 * trae un `ownerId`, aquí ni se lee.
 */

export function clubOwner(principal: Principal, clubId: string) {
  return forOwner(principal, { type: "CLUB", clubId });
}

export function promoterOwner(principal: Principal) {
  if (!principal.promoterId) throw AppError.forbidden();
  return forOwner(principal, { type: "PROMOTER", promoterId: principal.promoterId });
}

/**
 * Para las rutas compartidas entre los dos paneles. `clubId` viene de la
 * URL, no del body: una ruta bajo /club/[slug]/ ya ha resuelto el slug
 * contra los clubs del usuario antes de llegar aquí.
 */
export function ownerFromRequest(principal: Principal, clubId: string | null): Owner {
  if (clubId) {
    if (!principal.clubRoles.has(clubId)) throw AppError.notFound("Club");
    return { type: "CLUB", clubId };
  }
  if (!principal.promoterId) throw AppError.forbidden();
  return { type: "PROMOTER", promoterId: principal.promoterId };
}
