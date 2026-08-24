import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVITE_CODE_LENGTH,
  MAX_USES_UNLIMITED,
  usageCondition,
  formatInviteCode,
  generateInviteCode,
  inviteProblem,
  inviteProblemMessage,
  looksLikeInviteCode,
  normalizeInviteCode,
} from "@nightlife/core/invite";

const NOW = new Date("2026-08-22T22:00:00.000Z");

describe("generar códigos", () => {
  it("tiene la longitud acordada", () => {
    const code = generateInviteCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
  });

  it("no usa caracteres que la gente confunde al dictarlos", () => {
    // 0/O y 1/I/L fuera: estos códigos se leen en voz alta en una puerta.
    for (let seed = 0; seed < 256; seed += 1) {
      const bytes = new Uint8Array(8).fill(seed);
      const code = generateInviteCode(bytes);
      expect(/[01OIL]/.test(code)).toBe(false);
    }
  });

  it("el mismo azar da el mismo código y otro azar da otro", () => {
    const a = generateInviteCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const b = generateInviteCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const c = generateInviteCode(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("se niega a generar con poca entropía en vez de repetir bytes", () => {
    expect(() => generateInviteCode(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("lo que teclea una persona", () => {
  it("acepta minúsculas, guiones y espacios", () => {
    const code = generateInviteCode(new Uint8Array([5, 9, 13, 17, 21, 25, 29, 3]));
    expect(normalizeInviteCode(code.toLowerCase())).toBe(code);
    expect(normalizeInviteCode(`${code.slice(0, 4)}-${code.slice(4)}`)).toBe(code);
    expect(normalizeInviteCode(`  ${code}  `)).toBe(code);
  });

  it("arregla las confusiones típicas al leer", () => {
    expect(normalizeInviteCode("0")).toBe("O");
    expect(normalizeInviteCode("1")).toBe("I");
    expect(normalizeInviteCode("l")).toBe("I");
  });

  it("reconoce la forma antes de ir a la base de datos", () => {
    expect(looksLikeInviteCode("ABCD2345")).toBe(true);
    expect(looksLikeInviteCode("ABCD234")).toBe(false);
    expect(looksLikeInviteCode("ABCD2345X!")).toBe(false);
    expect(looksLikeInviteCode("ABCD0000")).toBe(false);
  });

  it("se enseña partido en dos, que se lee mucho mejor", () => {
    expect(formatInviteCode("ABCD2345")).toBe("ABCD-2345");
    expect(formatInviteCode("CORTO")).toBe("CORTO");
  });
});

describe("cuándo se puede canjear", () => {
  const base = { revokedAt: null, expiresAt: null, maxUses: 1, usedCount: 0 };

  it("una invitación nueva vale", () => {
    expect(inviteProblem(base, NOW)).toBe(null);
  });

  it("una revocada no, y lo dice", () => {
    const problem = inviteProblem({ ...base, revokedAt: NOW }, NOW);
    expect(problem).toBe("REVOKED");
    expect(inviteProblemMessage("REVOKED")).toContain("cancelled");
  });

  it("una caducada no", () => {
    expect(inviteProblem({ ...base, expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe("EXPIRED");
    expect(inviteProblem({ ...base, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(null);
  });

  it("caduca en el instante exacto, no un milisegundo después", () => {
    expect(inviteProblem({ ...base, expiresAt: NOW }, NOW)).toBe("EXPIRED");
  });

  it("una gastada no", () => {
    expect(inviteProblem({ ...base, maxUses: 1, usedCount: 1 }, NOW)).toBe("USED_UP");
    expect(inviteProblem({ ...base, maxUses: 5, usedCount: 4 }, NOW)).toBe(null);
  });

  it("maxUses 0 significa reutilizable, no agotada", () => {
    expect(inviteProblem({ ...base, maxUses: 0, usedCount: 999 }, NOW)).toBe(null);
  });

  it("revocada gana a caducada: se dice el motivo más definitivo", () => {
    const state = { revokedAt: NOW, expiresAt: new Date(NOW.getTime() - 1), maxUses: 1, usedCount: 0 };
    expect(inviteProblem(state, NOW)).toBe("REVOKED");
  });

  it("ningún mensaje filtra jerga", () => {
    for (const problem of ["MALFORMED", "REVOKED", "EXPIRED", "USED_UP"] as const) {
      const message = inviteProblemMessage(problem);
      expect(/error|null|undefined|prisma|sql/i.test(message)).toBe(false);
      expect(message.endsWith(".")).toBe(true);
    }
  });
});

describe("la condición de usos distingue limitado de ilimitado", () => {
  /*
   * El fallo que esta función existe para evitar: si el caso ilimitado
   * devolviera `{ lt: 0 }`, la condición `usedCount < 0` no se cumpliría jamás
   * y un código reutilizable no se podría canjear ni una sola vez.
   *
   * Antes esto era un ternario dentro de un `where` de Prisma. Funcionaba,
   * pero solo se podía comprobar por grep. Ahora se prueban los dos caminos.
   */

  it("con límite, pone el tope como condición", () => {
    expect(usageCondition(1)).toEqual({ lt: 1 });
    expect(usageCondition(2)).toEqual({ lt: 2 });
    expect(usageCondition(50)).toEqual({ lt: 50 });
  });

  it("sin límite, NO pone condición", () => {
    expect(usageCondition(MAX_USES_UNLIMITED)).toBe(null);
    expect(usageCondition(0)).toBe(null);
  });

  it("nunca devuelve una condición imposible de cumplir", () => {
    for (let maxUses = 0; maxUses <= 10; maxUses += 1) {
      const condition = usageCondition(maxUses);
      // `{ lt: 0 }` es la forma exacta del bug: se prohíbe que salga.
      if (condition) expect(condition.lt).toBeGreaterThan(0);
    }
  });

  it("un valor negativo se trata como ilimitado, no como imposible", () => {
    // No debería ocurrir — la ruta valida `min(0)` — pero si ocurre, la
    // consecuencia correcta es «sin condición», no «nunca canjeable».
    expect(usageCondition(-1)).toBe(null);
  });

  it("MAX_USES_UNLIMITED es 0, que es lo que guarda el esquema", () => {
    expect(MAX_USES_UNLIMITED).toBe(0);
  });
});

describe("nadie se mete en un club por su cuenta", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /** Los comentarios explican reglas y nombran justo lo que prohíben. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const files = walk(join(ROOT, "src")).map((path) => ({
    path: relative(ROOT, path).split("\\").join("/"),
    code: stripComments(readFileSync(path, "utf8")),
  }));

  it("la ruta de canje no acepta ningún clubId", () => {
    const route = files.find((f) => f.path === "src/app/api/v1/promoters/me/clubs/route.ts");
    expect(route).toBeDefined();
    // Si el esquema del cuerpo tuviera un clubId, cambiarlo te metería en el
    // club de otro. El único campo que entra es el código.
    expect(/clubId/.test(route!.code)).toBe(false);
  });

  it("el canje pasa por una transacción", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    expect(module!.code).toContain("$transaction");
  });

  it("el contador se incrementa con condición, no leyendo y escribiendo", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    // La condición viaja dentro del mismo UPDATE. Si alguien la sacara para
    // leer primero y escribir después, dos canjes simultáneos pasarían los dos.
    expect(module!.code).toContain("usageCondition(invite.maxUses)");
    expect(module!.code).toContain("increment: 1");
  });

  it("el caso ilimitado se resuelve sin condición", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    // `usage ? {...con condición} : {...sin ella}` — las dos ramas explícitas.
    expect(module!.code).toContain("usage ? { id: invite.id, usedCount: usage } : { id: invite.id }");
  });

  it("un promoter no puede acabar con dos relaciones con el mismo club", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    // `upsert` sobre la clave única: dos pestañas del mismo promoter con el
    // mismo código convergen a una fila en vez de chocar contra la restricción.
    expect(module!.code).toContain("tx.promoterClub.upsert");
    expect(module!.code).toContain("promoterId_clubId");
  });

  it("volver a canjear estando ya dentro no gasta un uso", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    // El retorno temprano de `alreadyMember` está ANTES del incremento.
    const earlyReturn = module!.code.indexOf("alreadyMember: true");
    const increment = module!.code.indexOf("increment: 1");
    expect(earlyReturn).toBeGreaterThan(0);
    expect(earlyReturn).toBeLessThan(increment);
  });

  it("invitedVia guarda el id de la invitación, no el código visible", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    // El código circula por WhatsApp y se revoca; el id es estable.
    expect(module!.code).toContain("invitedVia: invite.id");
    expect(module!.code).not.toContain("invitedVia: code");
    expect(module!.code).not.toContain("invitedVia: invite.code");
  });

  it("revocar y listar van siempre filtrados por club", () => {
    const module = files.find((f) => f.path === "src/packages/db/invites.ts");
    expect(module!.code).toContain("clubId: args.clubId");
  });
});
