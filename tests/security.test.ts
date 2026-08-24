import { describe, it, expect } from "vitest";
import {
  can,
  belongsToTenant,
  conversationScope,
  permissionsFor,
  type Principal,
} from "@nightlife/core/rbac";
import { validateSlug, slugify, suggestSlugs, RESERVED_SLUGS } from "@nightlife/core/slug";
import { hashPassword, verifyPassword, signSessionToken, verifySessionToken, hashCustomerHandle, signChatToken, verifyChatToken } from "@nightlife/auth/crypto";
import { assertPublicUrl, assertPublicEventUrl, canonicalPublicEventUrl, parseRobotsDisallow } from "@nightlife/ticketing/fourvenues";

const CLUB_A = "club_a";
const CLUB_B = "club_b";

const owner: Principal = {
  userId: "u_owner",
  globalRole: "USER",
  clubRoles: new Map([[CLUB_A, "CLUB_OWNER"]]),
  promoterClubIds: [],
};

const manager: Principal = {
  userId: "u_manager",
  globalRole: "USER",
  clubRoles: new Map([[CLUB_A, "CLUB_MANAGER"]]),
  promoterClubIds: [],
};

const promoter: Principal = {
  userId: "u_promoter",
  globalRole: "USER",
  clubRoles: new Map(),
  promoterId: "p_1",
  promoterClubIds: [CLUB_A],
};

const superAdmin: Principal = {
  userId: "u_admin",
  globalRole: "SUPER_ADMIN",
  clubRoles: new Map(),
  promoterClubIds: [],
};

describe("aislamiento entre tenants", () => {
  it("el owner del club A no pertenece al club B", () => {
    expect(belongsToTenant(owner, CLUB_A)).toBe(true);
    expect(belongsToTenant(owner, CLUB_B)).toBe(false);
  });

  it("no tiene ningún permiso sobre el club B", () => {
    expect(permissionsFor(owner, CLUB_B).size).toBe(0);
  });

  it("no puede leer las conversaciones del club B", () => {
    expect(conversationScope(owner, CLUB_B)).toBeNull();
  });

  it("no puede tocar eventos ni precios del club B", () => {
    expect(can(owner, CLUB_B, "event:write")).toBe(false);
    expect(can(owner, CLUB_B, "source:refresh")).toBe(false);
  });

  it("un promoter del club A no ve nada del club B", () => {
    expect(belongsToTenant(promoter, CLUB_B)).toBe(false);
    expect(conversationScope(promoter, CLUB_B)).toBeNull();
  });
});

describe("permisos del promoter", () => {
  it("ve sus clubs y sus eventos", () => {
    expect(can(promoter, CLUB_A, "club:read")).toBe(true);
    expect(can(promoter, CLUB_A, "event:read")).toBe(true);
  });

  it("no puede modificar la configuración del club", () => {
    expect(can(promoter, CLUB_A, "club:update")).toBe(false);
    expect(can(promoter, CLUB_A, "club:branding")).toBe(false);
  });

  it("no puede modificar precios ni eventos", () => {
    expect(can(promoter, CLUB_A, "event:write")).toBe(false);
    expect(can(promoter, CLUB_A, "source:import")).toBe(false);
  });

  it("solo ve sus propias conversaciones, nunca las de otros promoters", () => {
    expect(can(promoter, CLUB_A, "conversation:read:all")).toBe(false);
    expect(conversationScope(promoter, CLUB_A)).toEqual({ clubId: CLUB_A, promoterId: "p_1" });
  });
});

describe("owner frente a manager", () => {
  it("el manager opera el club pero no lo configura", () => {
    expect(can(manager, CLUB_A, "event:write")).toBe(true);
    expect(can(manager, CLUB_A, "source:import")).toBe(true);
    expect(can(manager, CLUB_A, "club:update")).toBe(false);
    expect(can(manager, CLUB_A, "club:branding")).toBe(false);
    expect(can(manager, CLUB_A, "channel:write")).toBe(false);
    expect(can(manager, CLUB_A, "club:delete")).toBe(false);
  });

  it("el owner sí", () => {
    expect(can(owner, CLUB_A, "club:update")).toBe(true);
    expect(can(owner, CLUB_A, "club:branding")).toBe(true);
    expect(can(owner, CLUB_A, "club:delete")).toBe(true);
  });
});

describe("super admin", () => {
  it("gestiona la plataforma", () => {
    expect(can(superAdmin, CLUB_A, "platform:admin")).toBe(true);
  });

  it("NO hereda acceso al contenido de las conversaciones de un club", () => {
    expect(can(superAdmin, CLUB_A, "conversation:read:all")).toBe(false);
    expect(conversationScope(superAdmin, CLUB_A)).toBeNull();
  });
});

describe("slugs", () => {
  it("no deja registrar rutas del sistema", () => {
    expect(validateSlug("admin")).toBe("RESERVED");
    expect(validateSlug("api")).toBe("RESERVED");
    expect(validateSlug("dashboard")).toBe("RESERVED");
    expect(RESERVED_SLUGS.has("login")).toBe(true);
  });

  it("acepta un slug normal de promoter", () => {
    expect(validateSlug("alex")).toBeNull();
    expect(validateSlug("alex-madrid")).toBeNull();
  });

  it("rechaza formatos inválidos", () => {
    expect(validateSlug("ab")).toBe("TOO_SHORT");
    expect(validateSlug("-alex")).toBe("INVALID_CHARS");
    expect(validateSlug("Alex Madrid")).toBe("INVALID_CHARS");
  });

  it("normaliza acentos y espacios", () => {
    expect(slugify("Álex Rodríguez")).toBe("alex-rodriguez");
    expect(slugify("Club Neón · Madrid")).toBe("club-neon-madrid");
  });

  it("sugiere alternativas cuando está cogido", () => {
    const taken = new Set(["alex", "alex1"]);
    expect(suggestSlugs("Alex", taken, 2)).toEqual(["alex2", "alex3"]);
  });
});

describe("contraseñas y sesiones", () => {
  it("verifica la contraseña correcta y rechaza la incorrecta", async () => {
    const hash = await hashPassword("una-clave-segura");
    expect(await verifyPassword("una-clave-segura", hash)).toBe(true);
    expect(await verifyPassword("otra-clave", hash)).toBe(false);
  });

  it("cada hash lleva su propia sal", async () => {
    const a = await hashPassword("misma-clave-123");
    const b = await hashPassword("misma-clave-123");
    expect(a).not.toBe(b);
  });

  it("rechaza contraseñas demasiado cortas", async () => {
    let threw = false;
    try {
      await hashPassword("corta");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("firma y verifica un token de sesión", async () => {
    const token = await signSessionToken({ sub: "u_1", email: "a@b.com" }, "secreto-de-test");
    const claims = await verifySessionToken(token, "secreto-de-test");
    expect(claims?.sub).toBe("u_1");
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = await signSessionToken({ sub: "u_1", email: "a@b.com" }, "secreto-de-test");
    expect(await verifySessionToken(token, "otro-secreto")).toBeNull();
  });

  it("rechaza un token manipulado", async () => {
    const token = await signSessionToken({ sub: "u_1", email: "a@b.com" }, "secreto-de-test");
    const parts = token.split(".");
    const tampered = `${parts[0]}.${btoa(JSON.stringify({ sub: "u_2", email: "x@y.com", iat: 1, exp: 9999999999 })).replace(/=+$/, "")}.${parts[2]}`;
    expect(await verifySessionToken(tampered, "secreto-de-test")).toBeNull();
  });

  it("rechaza un token caducado", async () => {
    const token = await signSessionToken({ sub: "u_1", email: "a@b.com" }, "s", -10);
    expect(await verifySessionToken(token, "s")).toBeNull();
  });

  it("el token de chat lleva el club atado", async () => {
    const token = await signChatToken({ conversationId: "c_1", clubId: "club_a" }, "s");
    const data = await verifyChatToken(token, "s");
    expect(data?.conversationId).toBe("c_1");
    expect(data?.clubId).toBe("club_a");
  });
});

describe("minimización de datos del cliente final", () => {
  it("el mismo teléfono en dos clubs da hashes distintos: no se pueden cruzar", async () => {
    const a = await hashCustomerHandle("+34600111222", "sal-club-a");
    const b = await hashCustomerHandle("+34600111222", "sal-club-b");
    expect(a).not.toBe(b);
  });

  it("es estable dentro del mismo club", async () => {
    const a = await hashCustomerHandle("+34600111222", "sal-club-a");
    const b = await hashCustomerHandle(" +34600111222 ", "sal-club-a");
    expect(a).toBe(b);
  });
});

describe("límites de acceso a la fuente externa", () => {
  it("acepta una URL pública de evento", () => {
    expect(assertPublicEventUrl("https://fourvenues.com/club-neon/events/summer-closing")).toMatch(
      /summer-closing/,
    );
  });

  it("acepta subdominios oficiales de Fourvenues", () => {
    expect(assertPublicUrl("https" + "://site.fourvenues.com/es/sala-mon")).toMatch(/site\.fourvenues\.com/);
  });

  it("canoniza un evento sin tocar el enlace de checkout", () => {
    const a = canonicalPublicEventUrl("https" + "://site.fourvenues.com/es/sala/events/closing?promoter=abc");
    const c = canonicalPublicEventUrl("https" + "://site.fourvenues.com/es/sala/events/closing?promoter=xyz#tickets");
    expect(a).toBe(c);
    expect(a).not.toMatch(/promoter|tickets/);
  });

  it("rechaza rutas de zona privada antes de hacer la petición", () => {
    expect(() => assertPublicUrl("https://fourvenues.com/admin/events/1")).toThrow();
    expect(() => assertPublicUrl("https://fourvenues.com/login")).toThrow();
    expect(() => assertPublicUrl("https://fourvenues.com/club/checkout/123")).toThrow();
  });

  it("rechaza otros dominios y http sin cifrar", () => {
    expect(() => assertPublicUrl("https://otro-sitio.com/evento")).toThrow();
    expect(() => assertPublicUrl("http://fourvenues.com/club/events/x")).toThrow();
  });

  it("pide la URL del evento, no la del perfil", () => {
    expect(() => assertPublicEventUrl("https://fourvenues.com/club-neon")).toThrow();
  });

  it("lee las reglas de robots.txt que le aplican", () => {
    const robots = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /api    # comentario
Allow: /
`;
    expect(parseRobotsDisallow(robots)).toEqual(["/admin", "/api"]);
  });
});
