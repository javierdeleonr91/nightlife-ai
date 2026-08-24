import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * El bug de next/font que se ha reintroducido varias veces.
 *
 * `axes` solo se puede usar cuando la fuente se carga como variable. Si además
 * se pasa `weight: ["600","700"]`, next/font rompe el build con «Invalid
 * axes value ... expected variable font». Es un fallo que no se ve en `dev`
 * y aparece en `build`, que es la peor combinación posible.
 *
 * Este test lo caza en cinco milisegundos en lugar de en un despliegue.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const layout = readFileSync(`${ROOT}src/app/layout.tsx`, "utf8");

/** Cada llamada a una fuente de next/font, con su cuerpo de opciones. */
function fontCalls(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const pattern = /\b([A-Z][A-Za-z_]*)\(\{([\s\S]*?)\}\)/g;
  for (const match of source.matchAll(pattern)) {
    const body = match[2] ?? "";
    if (/subsets\s*:/.test(body)) out.push({ name: match[1] as string, body });
  }
  return out;
}

describe("next/font", () => {
  const calls = fontCalls(layout);

  it("hay fuentes declaradas (si no, este test no vigila nada)", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it("ninguna fuente combina axes con pesos fijos", () => {
    const offenders = calls
      .filter((call) => /\baxes\s*:/.test(call.body))
      .filter((call) => /\bweight\s*:\s*\[/.test(call.body))
      .map((call) => call.name);
    expect(offenders).toEqual([]);
  });

  it("las fuentes con pesos fijos no piden axes", () => {
    const offenders = calls
      .filter((call) => /\bweight\s*:\s*\[/.test(call.body))
      .filter((call) => /\baxes\s*:/.test(call.body))
      .map((call) => call.name);
    expect(offenders).toEqual([]);
  });
});
