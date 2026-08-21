import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLANS,
  hasFeature,
  isEntitled,
  limitsFor,
  planByCode,
  withinAiQuota,
  type SubscriptionState,
} from "@nightlife/core/billing";
import { permissionsFor, type Principal } from "@nightlife/core/rbac";

/**
 * El modelo comercial, defendido por tests.
 *
 *   CLUB       nos paga software
 *   PROMOTER   nos paga software
 *   CLIENTE    paga su entrada a Fourvenues
 *   FOURVENUES gestiona el ticketing
 *
 * La plataforma no es intermediario financiero. Estos tests fallan el build si
 * alguien reintroduce comisiones, payouts, saldos o un panel de ventas del
 * promoter — que es exactamente el tipo de funcionalidad que vuelve a colarse
 * seis meses después "solo para mostrarlo".
 */

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "prisma"))].map((path) => ({
  path: relative(ROOT, path),
  code: stripComments(readFileSync(path, "utf8")),
}));

describe("no somos intermediarios financieros", () => {
  // Se buscan IDENTIFICADORES, no palabras sueltas: un campo `commissionCents`,
  // un modelo `Payout`, una función `calculateSettlement(...)`.
  //
  // La distinción importa. La página de suscripción dice en su copy "no
  // cobramos comisión por entrada", y esa frase debe poder existir — de hecho
  // es la que explica el modelo al promoter. Lo que no puede existir es un
  // campo que la calcule.
  const identifier = (word: string) =>
    new RegExp(
      // declaración de propiedad/variable, llamada a función, modelo Prisma
      String.raw`(?:\b\w*${word}\w*\s*[:=(]|\bmodel\s+\w*${word}\w*\b|\.\w*${word}\w*\s*[(:=])`,
      "i",
    );

  const FORBIDDEN: [string, RegExp][] = [
    ["comisiones", identifier("commission")],
    ["comisiones (es)", identifier("comision")],
    ["payouts", identifier("payout")],
    ["wallets", identifier("wallet")],
    ["saldos", /\b(balanceDue|walletBalance|availableBalance|promoterBalance)\b/],
    ["liquidaciones", identifier("settlement")],
    ["liquidaciones (es)", identifier("liquidacion")],
    ["revenue sharing", /\brevenue[_]?[Ss]har/],
    ["ganancias del promoter", /\bpromoter(Earnings|Revenue|Commission|Payout|Balance)\b/i],
  ];

  for (const [label, pattern] of FORBIDDEN) {
    it(`no hay ${label} en el código`, () => {
      const offenders = files.filter((f) => pattern.test(f.code)).map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  }

  it("no existe la entidad Sale en el esquema", () => {
    const schema = files.find((f) => f.path.endsWith("schema.prisma"));
    expect(schema).toBeDefined();
    expect(/model\s+Sale\b/.test(schema!.code)).toBe(false);
  });

  it("el contrato de ticketing no puede leer ventas ni atribución", () => {
    const types = files.find((f) => f.path.endsWith("ticketing/types.ts"));
    expect(types).toBeDefined();
    expect(/getSales\s*\??\s*\(/.test(types!.code)).toBe(false);
    expect(/getPromoterAttribution/.test(types!.code)).toBe(false);
    expect(/supportsSales|supportsPromoterAttribution/.test(types!.code)).toBe(false);
  });

  it("el dashboard del promoter no enseña ventas ni ingresos", () => {
    const home = files.find((f) => f.path.includes("promoter/home"));
    expect(home).toBeDefined();
    expect(/Mis ventas|entradas vendidas|ingresos|ganado/i.test(home!.code)).toBe(false);
  });

  it("no hay permisos de lectura de ventas en RBAC", () => {
    const rbac = files.find((f) => f.path.endsWith("core/rbac.ts"));
    expect(/sales:/.test(rbac!.code)).toBe(false);
  });

  it("ningún rol tiene un permiso relacionado con ventas", () => {
    const roles: Principal[] = [
      { userId: "u", globalRole: "USER", clubRoles: new Map([["c", "CLUB_OWNER"]]), promoterClubIds: [] },
      { userId: "u", globalRole: "USER", clubRoles: new Map([["c", "CLUB_MANAGER"]]), promoterClubIds: [] },
      { userId: "u", globalRole: "USER", clubRoles: new Map(), promoterId: "p", promoterClubIds: ["c"] },
      { userId: "u", globalRole: "SUPER_ADMIN", clubRoles: new Map(), promoterClubIds: [] },
    ];
    for (const role of roles) {
      const granted = [...permissionsFor(role, "c")];
      expect(granted.filter((p) => /sale|payout|commission|money/i.test(p))).toEqual([]);
    }
  });
});

describe("el promoter es un cliente que paga, no un afiliado que cobra", () => {
  it("hay planes de promoter y de club, ambos de pago hacia nosotros", () => {
    const audiences = new Set(PLANS.map((p) => p.audience));
    expect(audiences.has("PROMOTER")).toBe(true);
    expect(audiences.has("CLUB")).toBe(true);
  });

  it("todos los precios de plan son cobros nuestros, nunca negativos", () => {
    // Un importe negativo sería un pago DESDE la plataforma. No existe.
    for (const plan of PLANS) expect(plan.priceCents).toBeGreaterThanOrEqual(0);
  });

  it("ningún plan promete ver ventas o cobrar comisión", () => {
    for (const plan of PLANS) {
      for (const feature of plan.features) {
        expect(/sale|payout|commission|earning/i.test(feature)).toBe(false);
      }
    }
  });

  it("el plan gratuito del promoter da escaparate pero no asistente", () => {
    const free = planByCode("PROMOTER_FREE");
    expect(free?.features).toContain("public_link");
    expect(free?.features).not.toContain("ai_assistant");
  });

  it("el plan de pago del promoter incluye el asistente", () => {
    expect(planByCode("PROMOTER_PRO")?.features).toContain("ai_assistant");
  });
});

describe("acceso según suscripción", () => {
  const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
    planCode: "PROMOTER_PRO",
    status: "ACTIVE",
    ...over,
  });

  it("una prueba en curso da acceso", () => {
    expect(isEntitled(state({ status: "TRIALING" }))).toBe(true);
  });

  it("un recibo devuelto no corta el servicio de golpe", () => {
    // Cortarle el bot a un promoter un sábado por un impago le arruina la
    // noche y a nosotros el cliente. Se avisa y se corta al cancelar.
    expect(isEntitled(state({ status: "PAST_DUE" }))).toBe(true);
  });

  it("una suscripción cancelada no da acceso al asistente", () => {
    expect(isEntitled(state({ status: "CANCELED" }))).toBe(false);
    expect(hasFeature(state({ status: "CANCELED" }), "ai_assistant")).toBe(false);
  });

  it("sin suscripción no hay features", () => {
    expect(isEntitled(null)).toBe(false);
    expect(hasFeature(null, "ai_assistant")).toBe(false);
    expect(limitsFor(null)).toBeNull();
  });

  it("el plan gratuito no activa el asistente aunque esté activo", () => {
    expect(hasFeature(state({ planCode: "PROMOTER_FREE" }), "ai_assistant")).toBe(false);
    expect(hasFeature(state({ planCode: "PROMOTER_FREE" }), "public_link")).toBe(true);
  });

  it("la cuota de IA es un límite de producto, no un cargo extra", () => {
    const pro = state();
    const limit = limitsFor(pro)!.aiConversationsPerMonth;
    expect(withinAiQuota(pro, limit - 1)).toBe(true);
    expect(withinAiQuota(pro, limit)).toBe(false);
  });
});
