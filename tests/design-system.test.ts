import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * El design system, defendido por tests.
 *
 * Un sistema visual se erosiona igual que un modelo de negocio: no de golpe,
 * sino con un `#1f2937` suelto un martes por la tarde. Estos tests no juzgan
 * si algo es bonito —eso no se puede testear— pero sí que la identidad siga
 * saliendo de una sola fuente.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$|\.css$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = walk(join(ROOT, "src")).map((path) => ({
  path: relative(ROOT, path),
  code: stripComments(readFileSync(path, "utf8")),
}));

const tsx = files.filter((f) => f.path.endsWith(".tsx"));
const dashboard = tsx.filter((f) => f.path.includes("(dashboard)"));

describe("una sola fuente de color", () => {
  it("los colores literales solo viven en los tokens", () => {
    // Las páginas públicas y el chat son la excepción declarada: ahí el color
    // lo pone el branding del club, no nosotros.
    const allowed = [
      "src/design/tokens.css",
      "src/design/theme.ts",
      "src/packages/core/contrast.ts",
      "src/app/(public)/c/",
      "src/app/(public)/[promoterSlug]/",
      "src/components/club-invites.tsx",
      "src/components/chat-widget.tsx",
      "src/components/event-card.tsx",
      // Marcas de terceros: los colores de Google y el negro de Apple los
      // fijan ellos en sus normas de marca. No son decisiones nuestras y no
      // pueden salir de nuestros tokens.
      "src/components/auth-providers.tsx",
    ];
    const offenders = files
      .filter((f) => !allowed.some((a) => f.path.startsWith(a)))
      .filter((f) => /#[0-9a-fA-F]{6}\b/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("el panel no usa utilidades de color de Tailwind", () => {
    // La paleta de Tailwind está vaciada en la config, así que un
    // `bg-slate-800` ni siquiera compilaría. Este test lo detecta antes.
    const offenders = dashboard
      .filter((f) => /\b(bg|text|border)-(slate|gray|zinc|neutral|stone|red|blue|green|indigo|purple|pink)-\d{2,3}\b/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("elevación por luz, no por líneas", () => {
  it("el panel no dibuja bordes de 1px con utilidades", () => {
    // La decisión central del sistema: las superficies se separan por valor
    // y por sombra. Una interfaz llena de `border` vuelve a leer como panel
    // de administración por mucho que el color sea oscuro.
    const offenders = dashboard
      .filter((f) => /className="[^"]*\bborder(\s|-[trblxy]\b|")/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("movimiento", () => {
  it("todas las animaciones se apagan con prefers-reduced-motion", () => {
    const components = files.find((f) => f.path.endsWith("design/components.css"));
    expect(components).toBeDefined();
    expect(components!.code).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(components!.code).toMatch(/animation-duration: 0\.01ms !important/);
  });

  it("el easing sale de tokens, no de curvas sueltas por ahí", () => {
    const offenders = files
      .filter((f) => !f.path.includes("design/") && !f.path.includes("chat-widget"))
      .filter((f) => /cubic-bezier\(/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("accesibilidad", () => {
  it("hay un estado de foco visible definido", () => {
    const components = files.find((f) => f.path.endsWith("design/components.css"));
    expect(components!.code).toMatch(/:focus-visible/);
    expect(components!.code).toMatch(/--nl-ring/);
  });

  it("ningún componente elimina el outline sin poner algo en su lugar", () => {
    const offenders = files
      .filter((f) => /outline:\s*none/.test(f.code))
      .filter((f) => !/box-shadow|outline-color|focus-visible/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("los botones de solo icono llevan etiqueta accesible", () => {
    const offenders = tsx
      .filter((f) => /<button[^>]*>\s*✕\s*<\/button>/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("peso enviado al navegador", () => {
  it("solo son componentes de cliente los que de verdad interactúan", () => {
    // Cada "use client" es JavaScript que viaja al móvil de alguien. La lista
    // es explícita para que añadir uno nuevo sea una decisión, no un descuido.
    const clientFiles = tsx
      .filter((f) => /^\s*["']use client["']/.test(f.code))
      .map((f) => f.path)
      .sort();

    const expected = [
      "src/app/(public)/onboarding/page.tsx",
      "src/components/app-nav.tsx",
      "src/components/beta-feedback.tsx",
      "src/components/chat-widget.tsx",
      "src/components/club-invites.tsx",
      "src/components/event-selector.tsx",
      "src/components/fourvenues-connect.tsx",
      "src/components/handoff-list.tsx",
      "src/components/image-upload.tsx",
      "src/components/import-experience.tsx",
      "src/components/join-club.tsx",
      "src/components/password-form.tsx",
      "src/components/promoter-approval.tsx",
      "src/components/promoter-fourvenues-link.tsx",
      "src/components/refresh-button.tsx",
      "src/components/settings-form.tsx",
      "src/components/share-link.tsx",
      "src/components/toast.tsx",
      "src/components/unanswered-questions.tsx",
      "src/components/user-menu.tsx",
      "src/components/visibility-toggles.tsx",
    ];
    expect(clientFiles).toEqual(expected);
  });

  it("no se ha colado una librería de iconos ni de animación", () => {
    const heavy = /from\s+["'](lucide-react|react-icons|framer-motion|@heroicons)/;
    const offenders = files.filter((f) => heavy.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("el menú de usuario se puede alcanzar", () => {
  /*
   * Regresión de un fallo que no se ve leyendo el componente.
   *
   * El disparador del menú vive al final de una barra lateral de altura
   * completa. Si el desplegable se ancla por arriba (`top: 100%`), se pinta por
   * debajo del borde inferior de la pantalla: el botón «Log out» existe en el
   * DOM, es accesible por teclado y es invisible e inalcanzable con el ratón.
   *
   * La regla es que el menú se ancla SIEMPRE por abajo. Este test lee el CSS
   * de verdad, así que un cambio de posicionamiento lo despierta.
   */
  const css = readFileSync(join(ROOT, "src/design/components.css"), "utf8");

  function ruleFor(selector: string): string[] {
    const out: string[] = [];
    const pattern = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
    for (const match of css.matchAll(pattern)) out.push(match[1] as string);
    return out;
  }

  it("todas las declaraciones de .nl-menu lo anclan por abajo", () => {
    const blocks = ruleFor(".nl-menu");
    expect(blocks.length).toBeGreaterThan(0);

    const offenders = blocks
      .map((block) => /inset:\s*([^;]+);/.exec(block)?.[1]?.trim())
      .filter((inset): inset is string => Boolean(inset))
      // `inset: <top> <right> <bottom> <left>`: si el primero no es `auto`,
      // el menú se está anclando por arriba y se sale de la pantalla.
      .filter((inset) => !inset.startsWith("auto"));

    expect(offenders).toEqual([]);
  });

  it("y usa la altura del disparador para subir, no un valor suelto", () => {
    const blocks = ruleFor(".nl-menu");
    const withInset = blocks.filter((b) => /inset:/.test(b));
    expect(withInset.every((b) => /calc\(100% \+ \d+px\)/.test(b))).toBe(true);
  });
});
