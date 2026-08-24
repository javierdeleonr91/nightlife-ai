/**
 * Contraste.
 *
 * Los clubs eligen su color de marca y nosotros pintamos texto encima. Un club
 * con acento amarillo y texto blanco produce un botón COMPRAR que no se lee —
 * y ese botón es el producto entero. Así que la tinta no se decide a ojo: se
 * calcula.
 *
 * Fórmula de luminancia relativa de la WCAG 2.1. Sin dependencias.
 */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Las dos tintas posibles. Este archivo es, junto a tokens.css y theme.ts, uno
 * de los tres sitios donde puede vivir un color literal — el test de design
 * system lo tiene en su lista y falla si aparece un cuarto.
 *
 * INK_DARK debe coincidir con --nl-base. Casi negro en lugar de negro puro:
 * sobre un acento saturado se ve mejor y no vibra.
 */
export const INK_DARK = "#0B0A10";
export const INK_LIGHT = "#FFFFFF";

/**
 * Qué color de texto poner sobre un fondo dado. Elige el que más contraste da,
 * que es lo único que importa cuando el fondo lo decide otra persona.
 *
 * Nota: sobre nuestro propio acento (#FF2D6F) gana la tinta oscura — 5,50:1
 * frente a 3,59:1 del blanco. Además de cumplir, queda mejor.
 */
export function readableInkOn(background: string): string {
  const withDark = contrastRatio(INK_DARK, background);
  const withLight = contrastRatio(INK_LIGHT, background);
  if (withDark === null || withLight === null) return INK_LIGHT;
  return withDark >= withLight ? INK_DARK : INK_LIGHT;
}

/** ¿Este par cumple el mínimo de la WCAG para texto normal? */
export function meetsAA(foreground: string, background: string, largeText = false): boolean {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null) return false;
  return ratio >= (largeText ? 3 : 4.5);
}
