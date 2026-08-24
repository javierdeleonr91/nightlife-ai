import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrastRatio, meetsAA, readableInkOn, INK_DARK, INK_LIGHT } from "@nightlife/core/contrast";

/**
 * Contraste, comprobado con números.
 *
 * Una interfaz oscura y elegante es exactamente el sitio donde el contraste se
 * va al garete sin que nadie lo note: todo "se ve bien" en el monitor bueno
 * del diseñador y no se lee en un móvil al sol. Estos tests leen los tokens
 * reales del CSS y calculan.
 *
 * Ya cazaron dos fallos: el placeholder a 2,29:1 y el blanco sobre el acento
 * a 3,59:1.
 */

const TOKENS = readFileSync(
  fileURLToPath(new URL("../src/design/tokens.css", import.meta.url)),
  "utf8",
);

/** Lee un token de color directamente del CSS: la única fuente de verdad. */
function token(name: string): string {
  const match = TOKENS.match(new RegExp(`--nl-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Token --nl-${name} no encontrado o no es un hex`);
  return match[1];
}

const BASE = token("base");
const S1 = token("surface-1");
const S2 = token("surface-2");
const HOT = token("hot");

describe("la paleta cumple la WCAG", () => {
  const cases: [string, string, string, boolean][] = [
    ["texto base sobre el fondo", token("text"), BASE, false],
    ["texto base sobre surface-1", token("text"), S1, false],
    ["texto secundario sobre surface-1", token("text-2"), S1, false],
    ["hot-ink sobre surface-1", token("hot-ink"), S1, false],
    ["live sobre surface-1", token("live"), S1, false],
    ["warn sobre surface-1", token("warn"), S1, false],
    ["crit sobre surface-1", token("crit"), S1, false],
    ["violet-ink sobre surface-1", token("violet-ink"), S1, false],
  ];

  for (const [name, fg, bg, large] of cases) {
    it(`${name} llega a 4,5:1`, () => {
      expect(meetsAA(fg, bg, large)).toBe(true);
    });
  }

  it("los textos terciarios llegan al mínimo de texto grande (3:1)", () => {
    // Eyebrows y metadatos: pequeños pero nunca decorativos.
    expect(meetsAA(token("text-3"), S1, true)).toBe(true);
  });

  it("el placeholder se lee sobre el campo relleno", () => {
    const ratio = contrastRatio(token("text-4"), S2);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(3);
  });

  it("el acento se distingue del fondo", () => {
    expect(meetsAA(HOT, BASE, true)).toBe(true);
  });
});

describe("tinta sobre el acento", () => {
  it("sobre nuestro rosa gana la tinta oscura, no el blanco", () => {
    // 5,50:1 frente a 3,59:1. Cumple y además queda mejor.
    expect(readableInkOn(HOT)).toBe(INK_DARK);
    expect(meetsAA(INK_DARK, HOT)).toBe(true);
    expect(meetsAA(INK_LIGHT, HOT)).toBe(false);
  });

  it("el token del botón apunta a la tinta oscura", () => {
    expect(TOKENS).toMatch(/--nl-hot-fg:\s*var\(--nl-void\)/);
  });

  it("sobre un acento oscuro elige blanco", () => {
    expect(readableInkOn("#101014")).toBe(INK_LIGHT);
  });

  it("sobre un acento claro elige tinta oscura", () => {
    // El caso que rompe los productos: un club con marca amarilla.
    expect(readableInkOn("#FFD400")).toBe(INK_DARK);
    expect(meetsAA(readableInkOn("#FFD400"), "#FFD400")).toBe(true);
  });

  it("cualquier acento de club acaba con una combinación legible", () => {
    const brands = ["#FF2D6F", "#FFD400", "#00E5FF", "#111111", "#FFFFFF", "#7B5CFF", "#3DDC97"];
    for (const brand of brands) {
      const ink = readableInkOn(brand);
      const ratio = contrastRatio(ink, brand)!;
      // 3:1 es el mínimo para el texto de un botón grande; casi todos pasan de 4,5.
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });

  it("un color inválido no rompe la página, cae a blanco", () => {
    expect(readableInkOn("no-es-un-color")).toBe(INK_LIGHT);
    expect(contrastRatio("nope", "#000000")).toBeNull();
  });
});

describe("la utilidad de contraste", () => {
  it("calcula los extremos correctamente", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 2);
  });

  it("acepta hex de tres dígitos", () => {
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 1);
  });
});
