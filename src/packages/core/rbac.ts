/**
 * RBAC y contexto de tenant.
 *
 * Las comprobaciones viven aquí, en funciones puras y testeables, no
 * repartidas por los handlers. Un handler que se olvide de llamarlas es un
 * bug visible en revisión; una comprobación inline mal copiada, no.
 */

export type GlobalRole = "USER" | "SUPER_ADMIN";
export type ClubRole = "CLUB_OWNER" | "CLUB_MANAGER";

export interface Principal {
  readonly userId: string;
  readonly globalRole: GlobalRole;
  /** Clubs donde es miembro del staff, con su rol. */
  readonly clubRoles: ReadonlyMap<string, ClubRole>;
  /** Id de promoter si esta persona además es promoter. */
  readonly promoterId?: string;
  /** Clubs donde su alta como promoter está APROBADA. */
  readonly promoterClubIds: readonly string[];
}

export type Permission =
  | "club:read"
  | "club:update"
  | "club:branding"
  | "club:delete"
  | "event:read"
  | "event:write"
  | "source:import"
  | "source:refresh"
  | "vip:write"
  | "faq:write"
  | "channel:write"
  | "promoter:approve"
  | "conversation:read:all"
  | "conversation:read:own"
  | "conversation:handoff"
  | "platform:admin";

const OWNER_PERMISSIONS: readonly Permission[] = [
  "club:read", "club:update", "club:branding", "club:delete",
  "event:read", "event:write", "source:import", "source:refresh",
  "vip:write", "faq:write", "channel:write", "promoter:approve",
  "conversation:read:all", "conversation:read:own", "conversation:handoff",
];

// El manager opera el club día a día pero no toca configuración, marca,
// canales ni la existencia del club. Es la diferencia entre quien trabaja
// en el club y quien responde de él.
const MANAGER_PERMISSIONS: readonly Permission[] = [
  "club:read",
  "event:read", "event:write", "source:import", "source:refresh",
  "vip:write", "faq:write", "promoter:approve",
  "conversation:read:all", "conversation:read:own", "conversation:handoff",
];

// El promoter no es del club: ve lo suyo y nada más.
const PROMOTER_PERMISSIONS: readonly Permission[] = [
  "club:read",
  "event:read",
  "conversation:read:own",
];

export function permissionsFor(principal: Principal, clubId: string): ReadonlySet<Permission> {
  const granted = new Set<Permission>();

  if (principal.globalRole === "SUPER_ADMIN") {
    // El super admin gestiona la plataforma: suspender, ver estado, planes.
    // No hereda acceso al contenido de las conversaciones de ningún club.
    granted.add("platform:admin");
    granted.add("club:read");
    granted.add("promoter:approve");
  }

  const clubRole = principal.clubRoles.get(clubId);
  if (clubRole === "CLUB_OWNER") {
    for (const p of OWNER_PERMISSIONS) granted.add(p);
  } else if (clubRole === "CLUB_MANAGER") {
    for (const p of MANAGER_PERMISSIONS) granted.add(p);
  }

  if (principal.promoterClubIds.includes(clubId)) {
    for (const p of PROMOTER_PERMISSIONS) granted.add(p);
  }

  return granted;
}

export function can(principal: Principal, clubId: string, permission: Permission): boolean {
  return permissionsFor(principal, clubId).has(permission);
}

/** ¿Esta persona puede siquiera ver que este club existe como recurso suyo? */
export function belongsToTenant(principal: Principal, clubId: string): boolean {
  return (
    principal.clubRoles.has(clubId) ||
    principal.promoterClubIds.includes(clubId) ||
    principal.globalRole === "SUPER_ADMIN"
  );
}

/**
 * Filtro de conversaciones. Un promoter solo ve las suyas; el staff del club
 * las ve todas. Devuelve el criterio, no el resultado: así el filtro es
 * imposible de olvidar en la consulta.
 */
export function conversationScope(
  principal: Principal,
  clubId: string,
): { clubId: string; promoterId?: string } | null {
  if (can(principal, clubId, "conversation:read:all")) return { clubId };
  if (can(principal, clubId, "conversation:read:own") && principal.promoterId) {
    return { clubId, promoterId: principal.promoterId };
  }
  return null;
}
