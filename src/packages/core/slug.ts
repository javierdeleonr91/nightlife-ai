/**
 * Slugs. Los links de promoter viven en la raíz (/alex), así que el espacio
 * de nombres es global y finito: hay que reservar las rutas del sistema
 * antes de que alguien registre el promoter "admin".
 */

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "admin", "auth", "login", "logout", "register", "signup", "signin",
  "dashboard", "club", "clubs", "promoter", "promoters", "event", "events",
  "c", "p", "chat", "help", "support", "legal", "privacy", "terms", "cookies",
  "settings", "account", "billing", "pricing", "about", "contact", "blog",
  "static", "assets", "public", "_next", "favicon.ico", "robots.txt",
  "sitemap.xml", "well-known", "app", "www", "mail", "webhooks", "health",
]);

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export type SlugProblem = "TOO_SHORT" | "TOO_LONG" | "INVALID_CHARS" | "RESERVED";

export function validateSlug(slug: string): SlugProblem | null {
  if (slug.length < 3) return "TOO_SHORT";
  if (slug.length > 48) return "TOO_LONG";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) return "INVALID_CHARS";
  if (RESERVED_SLUGS.has(slug)) return "RESERVED";
  return null;
}

/** Alternativas cuando el slug está pillado. Sufijo numérico, nunca hash feo. */
export function suggestSlugs(base: string, taken: ReadonlySet<string>, count = 3): string[] {
  const root = slugify(base) || "user";
  const out: string[] = [];
  if (validateSlug(root) === null && !taken.has(root)) out.push(root);
  for (let i = 1; out.length < count && i < 100; i++) {
    const candidate = `${root}${i}`;
    if (validateSlug(candidate) === null && !taken.has(candidate)) out.push(candidate);
  }
  return out;
}
