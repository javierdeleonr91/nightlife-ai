import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tests de arquitectura.
 *
 * Las fronteras entre capas solo se sostienen si algo falla cuando se cruzan.
 * Estos tests son ese algo: fallan el build, no una revisión de código que
 * alguien puede saltarse un viernes a las once de la noche.
 */

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

/** Los comentarios explican reglas y a menudo nombran justo lo que prohíben. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sourceFiles = walk(join(ROOT, "src")).map((path) => {
  const content = readFileSync(path, "utf8");
  return { path: relative(ROOT, path), content, code: stripComments(content) };
});

describe("aislamiento de tenant por construcción", () => {
  it("nadie fuera de packages/db importa PrismaClient", () => {
    const offenders = sourceFiles
      .filter((f) => !f.path.startsWith("src/packages/db"))
      .filter((f) => /from\s+["']@prisma\/client["']/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("el cliente crudo solo se importa con el nombre que avisa de lo que es", () => {
    // El alias `unsafePrismaForMigrationsOnly` existe para que usarlo cante en
    // una revisión. Importar `prisma` a secas desde fuera del paquete, no.
    const offenders = sourceFiles
      .filter((f) => !f.path.startsWith("src/packages/db"))
      .filter((f) => /import\s*\{[^}]*\bprisma\b[^}]*\}\s*from\s+["']@nightlife\/db\/client["']/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("el núcleo de dominio no depende del framework", () => {
  const coreDirs = ["src/packages/core", "src/packages/ticketing", "src/packages/ai", "src/packages/auth"];
  const forbidden = [/from\s+["']next/, /from\s+["']react/, /from\s+["']@prisma/, /from\s+["']zod["']/];

  for (const dir of coreDirs) {
    it(`${dir} no importa next, react, prisma ni zod`, () => {
      const offenders = sourceFiles
        .filter((f) => f.path.startsWith(dir))
        .filter((f) => forbidden.some((pattern) => pattern.test(f.code)))
        .map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  }

  it("el motor de IA no hace peticiones de red por su cuenta", () => {
    // La única excepción es llm.ts, que es precisamente el adaptador de red.
    const offenders = sourceFiles
      .filter((f) => f.path.startsWith("src/packages/ai") && !f.path.endsWith("llm.ts"))
      .filter((f) => /\bfetch\s*\(/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("secretos", () => {
  it("ninguna variable sensible se expone con el prefijo público", () => {
    const offenders = sourceFiles
      .filter((f) =>
        /NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|PEPPER|DATABASE)/.test(f.code),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("los componentes de cliente no leen process.env de servidor", () => {
    const offenders = sourceFiles
      .filter((f) => f.content.startsWith('"use client"') || f.content.startsWith("'use client'"))
      .filter((f) => /process\.env\.(?!NEXT_PUBLIC_)[A-Z_]+/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("el widget público no persiste nada en el dispositivo", () => {
  it("sin localStorage ni sessionStorage en las páginas públicas", () => {
    // Mantenerlo así es lo que permite que la página pública funcione sin
    // banner de cookies, que es justo lo que estorba a la conversión.
    const offenders = sourceFiles
      .filter((f) => f.path.includes("(public)") || f.path.includes("chat-widget"))
      .filter((f) => /\b(localStorage|sessionStorage|document\.cookie)\b/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
