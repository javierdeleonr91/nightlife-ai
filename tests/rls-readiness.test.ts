import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ¿Puede la aplicación funcionar con `nl_app`?
 *
 * El fallo que estas guardas persiguen no se parece a un fallo: la consulta
 * es válida, no lanza nada y devuelve **cero filas**. El panel sale vacío y
 * el asistente dice que no hay eventos. Nadie mira los logs porque no hay
 * nada en los logs.
 *
 * Por eso la comprobación es estática y exhaustiva: recorre todo `src/` y
 * exige que ninguna tabla bajo RLS se toque con el cliente global.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Las tablas con política, en nombre de modelo Prisma. */
const MODELOS_BAJO_RLS = [
  "event", "eventSource", "ticketType", "ticketPrice", "dataPoint", "vIPOption",
  "fAQ", "knowledgeItem", "customer", "conversation", "message", "channel",
  "followUp", "sale", "promoterEvent", "brandSettings", "aiConfig",
  "aiRequestLog", "unansweredQuestion", "betaFeedback", "promoterKnowledge",
  "promoterFAQ",
];

/**
 * `promoterClub` y `clubMember` NO están en la lista de arriba a propósito:
 * la migración 011 les cambia el régimen. Ver el bloque de más abajo.
 */

function archivosTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) archivosTs(rel, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(rel);
  }
  return acc;
}

const FUENTES = archivosTs("src");

/**
 * Código sin comentarios.
 *
 * Varias de estas guardas buscan cadenas que también aparecen —a propósito—
 * en los comentarios que explican por qué NO se hacen. Comprobar sobre el
 * texto crudo daba falsos positivos: el archivo que documenta que BYPASSRLS
 * sería un error contiene la palabra BYPASSRLS.
 */
function sinComentarios(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Archivos donde el cliente global es la respuesta correcta, con su motivo. */
const EXENTOS: Record<string, string> = {
  "src/packages/db/client.ts": "es quien lo define",
  "src/packages/db/owner.ts": "es quien abre las transacciones con contexto",
  "src/packages/db/platform.ts": "trabajo de plataforma entre inquilinos; corre con DIRECT_URL",
};

describe("ninguna tabla bajo RLS se toca con el cliente global", () => {
  const patron = new RegExp(`\\bprisma\\.(${MODELOS_BAJO_RLS.join("|")})\\b`, "g");

  for (const archivo of FUENTES) {
    const motivo = EXENTOS[archivo];
    it(`${archivo}${motivo ? ` (exento: ${motivo})` : ""}`, () => {
      const hits = [...sinComentarios(read(archivo)).matchAll(patron)].map((m) => m[0]);
      if (motivo) return; // exento y documentado
      expect(hits).toEqual([]);
    });
  }
});

describe("buildConversationContext no coge el cliente por su cuenta", () => {
  const retrieval = read("src/packages/db/retrieval.ts");

  it("recibe el cliente por parámetro", () => {
    expect(retrieval).toContain("export async function buildConversationContext(\n  db: DbClient,");
  });

  it("no importa el cliente global", () => {
    // Si lo importara, podría volver a usarlo sin que nadie se enterase.
    expect(retrieval).not.toContain('from "./client"');
    expect(retrieval).not.toMatch(/\bprisma\./);
  });

  it("el historial entra como dato, no como consulta", () => {
    // `messages` es del dueño de la conversación; el catálogo es del club.
    // Para un RRPP no son el mismo contexto, así que no pueden leerse juntos.
    expect(retrieval).toContain("readonly history?:");
    expect(retrieval).not.toContain("db.message.findMany");
  });
});

describe("forTenant fija el club en cada operación", () => {
  const tenant = read("src/packages/db/tenant.ts");

  it("todo pasa por withOwnerRls", () => {
    // Antes usaba el cliente global sin fijar nada: el panel entero del club
    // se habría quedado vacío al cambiar DATABASE_URL.
    expect(tenant).toContain("withOwnerRls<T>({ type: \"CLUB\", clubId }, work)");
  });

  it("el único prisma global que queda es loadPrincipal", () => {
    const usos = [...tenant.matchAll(/\bprisma\.(\w+)/g)].map((m) => m[1]);
    expect(usos).toEqual(["user"]);
  });

  it("y el where de aplicación sigue puesto además de RLS", () => {
    expect(tenant).toContain("const where = { clubId };");
  });
});

describe("loadPrincipal: el login no puede depender de un include (app-06)", () => {
  const tenant = read("src/packages/db/tenant.ts");
  const fn = tenant.slice(tenant.indexOf("export async function loadPrincipal"));

  it("club_members sí puede ir en el include: 011 la saca de RLS", () => {
    expect(fn).toContain("clubMemberships: true,");
  });

  it("promoter_clubs NO: sigue bajo RLS y sin contexto vuelve vacía", () => {
    // Con el include, `promoterClubIds` sería [] para todos los RRPPs. No
    // un error: el panel diciéndole que no trabaja con ningún club.
    expect(fn).not.toMatch(/promoter:\s*\{\s*include/);
    expect(fn).toContain("promoter: { select: { id: true } },");
  });

  it("se lee aparte, en el contexto del propio RRPP", () => {
    expect(fn).toMatch(/withOwnerRls\(\{\s*type:\s*"PROMOTER",\s*promoterId\s*\}/);
    expect(fn).toContain("tx.promoterClub");
    expect(fn).toContain('status: "APPROVED"');
  });

  it("y no hay circularidad: el promoterId sale de una tabla sin RLS", () => {
    // `promoters` está fuera de RLS a propósito. Para saber qué clubs son
    // suyos hace falta saber quién es él, y eso ya se sabe.
    expect(fn.indexOf("prisma.user.findUnique")).toBeLessThan(fn.indexOf("withOwnerRls"));
  });
});

describe("el webchat público lee cada cosa en su contexto", () => {
  const route = read("src/app/api/v1/chat/route.ts");

  it("el historial, en el contexto del dueño", () => {
    expect(route).toContain("readConversationHistory(owner,");
  });

  it("el catálogo del club, en el contexto del club", () => {
    expect(route).toContain("withPublicClubRls(club.id,");
  });

  it("y se le pasa el historial ya leído", () => {
    expect(route).toContain("history,");
  });

  it("sigue sin fabricar un Principal", () => {
    expect(route).not.toContain("requirePrincipal");
    expect(route).not.toMatch(/import[^;]*\bPrincipal\b[^;]*from/);
  });
});

describe("withPublicClubRls es explícito y acotado", () => {
  const owner = read("src/packages/db/owner.ts");

  it("existe con nombre propio", () => {
    // Con nombre propio se puede auditar quién lo usa; escondido dentro de
    // otra función, no.
    expect(owner).toContain("export function withPublicClubRls");
  });

  it("no es un bypass: reutiliza withOwnerRls", () => {
    const fn = owner.slice(owner.indexOf("export function withPublicClubRls"));
    expect(fn.slice(0, 300)).toContain('withOwnerRls({ type: "CLUB", clubId }, work)');
  });

  it("solo lo usan los sitios que leen catálogo público", () => {
    const usuarios = FUENTES.filter(
      (f) => f !== "src/packages/db/owner.ts" && read(f).includes("withPublicClubRls("),
    ).sort();
    expect(usuarios).toEqual([
      "src/app/(dashboard)/promoter/events/page.tsx",
      // app-06: el panel del RRPP leía sus clubs y sus noches como
      // relaciones anidadas desde `prisma.promoter`. Mismo patrón, misma
      // consecuencia: el panel vacío sin un solo error.
      "src/app/(dashboard)/promoter/home/page.tsx",
      // app-06: las dos páginas públicas. Leían marca, VIP, eventos y
      // tarifas como relaciones anidadas desde `clubs`/`promoters`, que no
      // están bajo RLS; con nl_app volvían vacías sin dar error.
      "src/app/(public)/[promoterSlug]/page.tsx",
      "src/app/(public)/c/[clubSlug]/page.tsx",
      "src/app/api/v1/chat/route.ts",
      "src/app/api/v1/promoters/me/events/route.ts",
    ]);
  });
});

describe("las dos variables, siempre, en la misma transacción", () => {
  const owner = read("src/packages/db/owner.ts");

  it("CLUB: club fijado y promoter vacío", () => {
    expect(owner).toContain('const clubId = owner.type === "CLUB" ? owner.clubId : "";');
  });

  it("PROMOTER: promoter fijado y club vacío", () => {
    expect(owner).toContain('const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";');
  });

  it("las dos con true, en la misma transacción", () => {
    const fn = owner.slice(owner.indexOf("export function withOwnerRls"), owner.indexOf("export function withPublicClubRls"));
    expect(fn.match(/set_config\('app\./g)?.length).toBe(2);
    expect(fn).toContain("prisma.$transaction");
    expect(fn).not.toContain(", false)");
  });

  it("nadie más fija esas variables por su cuenta", () => {
    // Un `set_config` suelto fuera de owner.ts sería una vía para dejar una
    // variable a nivel de sesión, que es la contaminación que evitamos.
    const otros = FUENTES.filter(
      (f) => f !== "src/packages/db/owner.ts" && /set_config\('app\./.test(sinComentarios(read(f))),
    );
    expect(otros).toEqual([]);
  });
});

describe("011: las tablas de pertenencia", () => {
  const sql = read("prisma/migrations/manual/011-rls-membership.sql");

  it("saca club_members de RLS, que es la tabla de autorización", () => {
    expect(sql).toContain("ALTER TABLE club_members DISABLE ROW LEVEL SECURITY");
  });

  it("da a promoter_clubs y promoter_events una política de dos caras", () => {
    expect(sql).toContain("current_setting('app.current_promoter_id', true)");
    expect(sql).toContain("promoter_clubs");
    expect(sql).toContain("promoter_events");
  });

  it("no borra ni altera ninguna columna", () => {
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toMatch(/ALTER TABLE \w+ ALTER COLUMN/);
  });

  it("y no concede BYPASSRLS a nadie", () => {
    expect(sql).not.toContain("BYPASSRLS");
    expect(sql).not.toContain("SECURITY DEFINER");
  });
});

describe("ningún atajo", () => {
  it("nadie pide BYPASSRLS ni desactiva FORCE en src", () => {
    for (const f of FUENTES) {
      const code = sinComentarios(read(f));
      expect(code).not.toContain("BYPASSRLS");
      expect(code).not.toContain("NO FORCE ROW LEVEL SECURITY");
      expect(code).not.toContain("row_security = off");
    }
  });

  it("ni se cuela un as any en la capa de datos", () => {
    for (const f of FUENTES.filter((x) => x.startsWith("src/packages/db/"))) {
      expect(sinComentarios(read(f))).not.toContain("as any");
    }
  });
});

describe("PKCE_COOKIE vive donde Next lo permite", () => {
  it("se define en lib/oauth.ts", () => {
    // Un route.ts solo puede exportar handlers: cualquier otra exportación
    // rompe el build con «is not a valid Route export field».
    expect(read("src/lib/oauth.ts")).toContain('export const PKCE_COOKIE = "nl_pkce";');
  });

  it("la ruta de inicio ya no lo exporta", () => {
    const start = read("src/app/auth/start/[provider]/route.ts");
    expect(start).not.toContain("export const PKCE_COOKIE");
    expect(start).toContain('from "@/lib/oauth"');
  });

  it("el callback lo importa de lib, no de la ruta", () => {
    const cb = read("src/app/auth/callback/route.ts");
    expect(cb).not.toContain('from "@/app/auth/start/[provider]/route"');
    expect(cb).toContain("PKCE_COOKIE");
  });

  it("las dos rutas siguen exportando solo lo que Next admite", () => {
    for (const f of ["src/app/auth/start/[provider]/route.ts", "src/app/auth/callback/route.ts"]) {
      // `m[1]` es `string | undefined` porque el tsconfig usa
      // `noUncheckedIndexedAccess`: TypeScript no da por hecho que un grupo
      // de captura exista. El grupo es obligatorio en el patrón, pero eso el
      // compilador no lo sabe, así que se descarta el hueco con un predicado
      // de tipo en vez de afirmarlo con `!`.
      const exports = [...read(f).matchAll(/^export (?:const|async function|function) (\w+)/gm)]
        .map((m) => m[1])
        .filter((nombre): nombre is string => nombre !== undefined);
      const permitidos = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "dynamic", "revalidate", "runtime", "fetchCache", "preferredRegion", "maxDuration"]);
      expect(exports.filter((e) => !permitidos.has(e))).toEqual([]);
    }
  });
});
