import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCheckoutUrl, canShowBuyButton, normalizePromoterLink } from "@nightlife/core/checkout";
import { FourvenuesPublicSource } from "@nightlife/ticketing/fourvenues";
import { ManualSource } from "@nightlife/ticketing/manual";

/**
 * El enlace de compra.
 *
 * Regla de §50, y la que más fácil sería incumplir sin darse cuenta: **nunca
 * componemos una URL de checkout**. Solo usamos las que publica Fourvenues.
 *
 * Añadir `?promoter=slug` parecía inofensivo. No lo es: inventa un contrato
 * con una ticketera que no controlamos. Si el parámetro no existe, no hace
 * nada; si existe y significa otra cosa, atribuimos ventas a quien no toca.
 * Es exactamente el mismo error que inventar un precio, en otro campo.
 */

const CLUB_URL = "https://fourvenues.com/club-neon/events/summer-closing";
const PROMOTER_URL = "https://fourvenues.com/club-neon/events/summer-closing/alex-7f3a";

describe("prioridad del checkout (§50)", () => {
  it("si el promoter tiene URL propia, esa manda", () => {
    const result = resolveCheckoutUrl({
      clubCheckoutUrl: CLUB_URL,
      promoterCheckoutUrl: PROMOTER_URL,
    });
    expect(result.url).toBe(PROMOTER_URL);
    expect(result.source).toBe("PROMOTER");
  });

  it("sin URL de promoter, se usa la oficial del club", () => {
    const result = resolveCheckoutUrl({ clubCheckoutUrl: CLUB_URL, promoterCheckoutUrl: null });
    expect(result.url).toBe(CLUB_URL);
    expect(result.source).toBe("CLUB");
  });

  it("sin ninguna URL no se inventa nada", () => {
    const result = resolveCheckoutUrl({ clubCheckoutUrl: null, promoterCheckoutUrl: null });
    expect(result.url).toBeNull();
    expect(result.source).toBe("NONE");
  });

  it("una URL rota del promoter no tumba la compra: cae al club", () => {
    const result = resolveCheckoutUrl({
      clubCheckoutUrl: CLUB_URL,
      promoterCheckoutUrl: "esto-no-es-una-url",
    });
    expect(result.url).toBe(CLUB_URL);
    expect(result.source).toBe("CLUB");
  });

  it("no se acepta http sin cifrar", () => {
    const result = resolveCheckoutUrl({ clubCheckoutUrl: "http://fourvenues.com/x/events/y" });
    expect(result.url).toBeNull();
  });
});

describe("cuándo se enseña el botón", () => {
  it("con URL y sin agotar, sí", () => {
    expect(canShowBuyButton({ checkoutUrl: CLUB_URL, soldOut: false })).toBe(true);
  });

  it("agotado no enseña botón aunque haya URL (§52)", () => {
    // Mandar a alguien a un checkout cerrado es peor que decirle que no quedan.
    expect(canShowBuyButton({ checkoutUrl: CLUB_URL, soldOut: true })).toBe(false);
  });

  it("sin URL, tampoco", () => {
    expect(canShowBuyButton({ checkoutUrl: null, soldOut: false })).toBe(false);
  });
});

describe("los proveedores devuelven la URL tal cual", () => {
  it("Fourvenues no añade nada a la URL del evento", () => {
    const source = new FourvenuesPublicSource();
    expect(source.getCheckoutUrl({ url: CLUB_URL })).toBe(CLUB_URL);
  });

  it("ManualSource tampoco", () => {
    const source = new ManualSource({
      name: "x",
      startsAtIso: "2026-10-03T23:59:00+02:00",
      ticketUrl: CLUB_URL,
    });
    expect(source.getCheckoutUrl({})).toBe(CLUB_URL);
  });
});

// ── guard de código ────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$|\.prisma$/.test(entry)) out.push(full);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "prisma"))].map((path) => ({
  path: relative(ROOT, path),
  code: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1"),
}));

describe("nadie vuelve a componer una URL de compra", () => {
  it("no se escriben parámetros de query sobre un enlace de checkout", () => {
    const offenders = files
      .filter((f) => /searchParams\.set\(\s*["'](promoter|ref|aff|affiliate|rrpp)["']/i.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("el contrato de ticketing no acepta opciones de checkout", () => {
    const types = files.find((f) => f.path.endsWith("ticketing/types.ts"));
    expect(types).toBeDefined();
    expect(/CheckoutOptions/.test(types!.code)).toBe(false);
    expect(/getCheckoutUrl\(ref: EventRef\)/.test(types!.code)).toBe(true);
  });

  it("el campo del esquema guarda una URL, no una etiqueta compuesta", () => {
    const schema = files.find((f) => f.path.endsWith("schema.prisma"));
    expect(/referralTag/.test(schema!.code)).toBe(false);
    expect(/checkoutUrl String\?/.test(schema!.code)).toBe(true);
  });
});

describe("configuración de base de datos (§59)", () => {
  it("el datasource conserva directUrl", () => {
    const schema = files.find((f) => f.path.endsWith("schema.prisma"));
    expect(/directUrl\s*=\s*env\("DIRECT_URL"\)/.test(schema!.code)).toBe(true);
  });

  it("DIRECT_URL está declarada en el entorno validado", () => {
    const env = files.find((f) => f.path.endsWith("config/env.ts"));
    expect(/DIRECT_URL/.test(env!.code)).toBe(true);
  });
});

describe("el rol de cuenta se guarda una sola vez (§6)", () => {
  it("existe el campo en el esquema", () => {
    const schema = files.find((f) => f.path.endsWith("schema.prisma"));
    expect(/enum AccountType/.test(schema!.code)).toBe(true);
    expect(/accountType\s+AccountType\?/.test(schema!.code)).toBe(true);
  });

  it("se escribe al crear club y al crear promoter", () => {
    const clubs = files.find((f) => f.path.includes("api/v1/clubs/route"));
    const promoters = files.find((f) => f.path.includes("api/v1/promoters/route"));
    expect(/accountType: "CLUB"/.test(clubs!.code)).toBe(true);
    expect(/accountType: "PROMOTER"/.test(promoters!.code)).toBe(true);
  });
});

describe("link personal de Fourvenues del RRPP", () => {
  it("acepta un link real de Fourvenues tal cual, con sus parámetros", () => {
    const link = "https://www.fourvenues.com/es/club/events/noche?rrpp=maria";
    expect(normalizePromoterLink(link)).toBe(link);
  });

  it("no le añade ni le quita nada", () => {
    const link = "https://fourvenues.com/es/club/events/noche";
    expect(normalizePromoterLink(link)).toBe(link);
    expect(normalizePromoterLink(link)).not.toContain("promoter=");
  });

  it("rechaza cualquier host que no sea Fourvenues", () => {
    expect(normalizePromoterLink("https://example.com/x")).toBe(null);
    expect(normalizePromoterLink("https://fourvenues.com.evil.net/x")).toBe(null);
  });

  it("rechaza http y basura", () => {
    expect(normalizePromoterLink("http://fourvenues.com/x")).toBe(null);
    expect(normalizePromoterLink("no soy una url")).toBe(null);
    expect(normalizePromoterLink("")).toBe(null);
    expect(normalizePromoterLink(null)).toBe(null);
  });
});
