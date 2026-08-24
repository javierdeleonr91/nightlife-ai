import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * El flujo público, revisado archivo por archivo.
 *
 * ── Qué prueba esto y qué NO ─────────────────────────────────────────
 * Estas guardas son ESTÁTICAS: leen el código y comprueban su forma. No
 * levantan Next, no abren una conexión y no ejecutan una sola consulta.
 *
 * Lo digo aquí porque el fallo que persiguen es precisamente uno que un
 * test de integración normal tampoco pillaría: con el rol de desarrollo
 * —que no está sujeto a RLS— las consultas malas pasan en verde. Solo
 * fallan con `nl_app`, en producción, y fallan devolviendo cero filas sin
 * error. Un test que corriese con el rol de siempre daría una falsa
 * tranquilidad peor que no tener test.
 *
 * El comportamiento real, contra PostgreSQL y con el rol `nl_app` puesto,
 * está en prisma/migrations/manual/tests/public-flow-tests.sql, que
 * demuestra el JOIN vacío y el arreglo. Estas dos piezas se complementan:
 * el SQL prueba que el motor se comporta así, esto prueba que el código no
 * vuelve a pedírselo.
 *
 * ── El patrón que se persigue ────────────────────────────────────────
 *
 *     prisma.club.findUnique({ include: { brand: true, events: … } })
 *              ↑ sin RLS                    ↑ con RLS   ↑ con RLS
 *
 * La raíz resuelve, las relaciones vuelven vacías, la página responde 200.
 * Se me escapó entero en la auditoría de app-04 porque busqué accesos con
 * la forma `prisma.<modeloBajoRLS>` y estos no la tienen.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const PAGINA_CLUB = "src/app/(public)/c/[clubSlug]/page.tsx";
const PAGINA_RRPP = "src/app/(public)/[promoterSlug]/page.tsx";
const RUTA_CHAT = "src/app/api/v1/chat/route.ts";
const WEBCHAT = "src/packages/db/webchat.ts";
const BILLING = "src/packages/core/billing.ts";

/** Los modelos que el cliente global toca en un archivo. Sin comentarios. */
function modelosGlobales(codigo: string): string[] {
  const limpio = codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...new Set([...limpio.matchAll(/\bprisma\.(\w+)\b/g)].map((m) => m[1]!))].sort();
}

// ════════════════════════════════════════════════════════════════════
// 1 · Los perfiles públicos no dependen del prisma global
// ════════════════════════════════════════════════════════════════════

describe("1 · los perfiles públicos no leen tablas con RLS por el cliente global", () => {
  it("el perfil del club: el global solo toca `clubs`", () => {
    // `clubs` no está bajo RLS a propósito: es la tabla que resuelve el
    // slug de la URL, y eso pasa antes de saber qué club fijar.
    expect(modelosGlobales(read(PAGINA_CLUB))).toEqual(["club"]);
  });

  it("el perfil del RRPP: el global solo toca `promoters` y `clubs`", () => {
    expect(modelosGlobales(read(PAGINA_RRPP))).toEqual(["club", "promoter"]);
  });

  it("el endpoint del chat: el global solo toca `clubs`", () => {
    // `subscriptions` se lee por getSubscriptionState, que vive en
    // packages/db; tampoco está bajo RLS.
    expect(modelosGlobales(read(RUTA_CHAT))).toEqual(["club"]);
  });

  it("ya no queda ningún include anidado hacia una tabla con políticas", () => {
    const club = read(PAGINA_CLUB);
    // Las cinco relaciones que volvían vacías con nl_app.
    expect(club).not.toContain("brand: true");
    expect(club).not.toMatch(/vipOptions:\s*\{\s*where/);
    expect(club).not.toMatch(/prisma\.club\.findUnique\([^)]*include/s);

    const rrpp = read(PAGINA_RRPP);
    expect(rrpp).not.toMatch(/prisma\.promoter\.findUnique\([^)]*include/s);
    expect(rrpp).not.toContain("club: { include: { brand: true } }");

    const chat = read(RUTA_CHAT);
    // `ai_configs` está bajo RLS: en un include desde `clubs` volvía null
    // y el tope de gasto diario del club dejaba de existir en silencio.
    expect(chat).not.toContain("include: { aiConfig: true }");
  });

  it("y cada tabla con políticas se lee por el cliente de la transacción", () => {
    const club = read(PAGINA_CLUB);
    for (const lectura of ["tx.brandSettings.findUnique", "tx.vIPOption.findMany", "tx.event.findMany"]) {
      expect(club).toContain(lectura);
    }
    const rrpp = read(PAGINA_RRPP);
    for (const lectura of [
      "tx.promoterClub.findMany",
      "tx.promoterEvent.findMany",
      "tx.brandSettings.findUnique",
      "tx.event.findMany",
    ]) {
      expect(rrpp).toContain(lectura);
    }
    expect(read(RUTA_CHAT)).toContain("tx.aiConfig.findUnique");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 · El dueño se deriva en el servidor
// ════════════════════════════════════════════════════════════════════

describe("2 · el dueño se deriva en el servidor desde el slug público", () => {
  it("el perfil del club fija el club que acaba de resolver", () => {
    expect(read(PAGINA_CLUB)).toContain("withPublicClubRls(club.id,");
  });

  it("el perfil del RRPP se lee como PROMOTER, no como club", () => {
    // Lo suyo (altas y eventos elegidos) es suyo. Fijar un club aquí
    // funcionaría y diría algo falso.
    expect(read(PAGINA_RRPP)).toMatch(/withOwnerRls\(\s*\{\s*type:\s*"PROMOTER",\s*promoterId:\s*promoter\.id\s*\}/);
  });

  it("y el catálogo de cada club, en el contexto de ese club", () => {
    expect(read(PAGINA_RRPP)).toContain("withPublicClubRls(clubId,");
  });

  it("resolveWebchatOwner cuenta el alta en contexto de PROMOTER", () => {
    const wc = read(WEBCHAT);
    // Este era el fallo grave: el alta venía en un select anidado desde
    // `prisma.promoter`. Vacía siempre → dueño CLUB siempre → el club
    // leyendo los DM del RRPP.
    expect(wc).not.toMatch(/prisma\.promoter\.findUnique\([^;]*clubs:/s);
    expect(wc).toMatch(/withOwnerRls\(\{\s*type:\s*"PROMOTER",\s*promoterId:\s*promoter\.id\s*\}/);
    expect(wc).toContain("tx.promoterClub.count(");
    expect(wc).toContain('status: "APPROVED"');
  });

  it("ningún archivo del flujo público fabrica un Principal", () => {
    for (const f of [PAGINA_CLUB, PAGINA_RRPP, RUTA_CHAT, WEBCHAT]) {
      const code = read(f);
      expect(code).not.toContain("requirePrincipal");
      expect(code).not.toMatch(/import[^;]*\bPrincipal\b[^;]*from/);
      expect(code).not.toMatch(/import[^;]*\bforOwner\b[^;]*from/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 3 · El frontend no puede elegir dueño
// ════════════════════════════════════════════════════════════════════

describe("3 · el frontend no puede elegir dueño", () => {
  it("el esquema de la petición no admite ownerType ni ownerId", () => {
    const chat = read(RUTA_CHAT);
    const esquema = chat.slice(chat.indexOf("const schema = z.object("), chat.indexOf("export async function POST"));
    for (const campo of ["ownerType", "ownerClubId", "ownerPromoterId", "promoterId", "clubId"]) {
      expect(esquema).not.toContain(campo);
    }
    // Lo único que llega del navegador son dos slugs públicos y el token.
    expect(esquema).toContain("clubSlug");
    expect(esquema).toContain("promoterSlug");
  });

  it("el dueño sale de resolveWebchatOwner y de nada más", () => {
    const chat = read(RUTA_CHAT);
    expect(chat).toMatch(/const \{ owner, contextClubId, viaPromoterId \} = await resolveWebchatOwner\(/);
    // Ni una asignación posterior: el dueño se decide una vez.
    expect(chat).not.toMatch(/\bowner\s*=\s*(?!\{ owner)/);
  });

  it("los perfiles públicos no leen nada del cliente", () => {
    for (const f of [PAGINA_CLUB, PAGINA_RRPP]) {
      const code = read(f);
      expect(code).not.toContain("searchParams");
      expect(code).not.toContain('"use client"');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 4 · contextClubId no concede nada
// ════════════════════════════════════════════════════════════════════

describe("4 · contextClubId no autoriza", () => {
  it("no aparece en ninguna política de RLS", () => {
    for (const sql of [
      "prisma/rls-owner.sql",
      "prisma/migrations/manual/011-rls-membership.sql",
      "prisma/migrations/manual/001-channel-owner.sql",
    ]) {
      const texto = read(sql);
      const politicas = [...texto.matchAll(/CREATE POLICY[\s\S]*?;/g)].map((m) => m[0]).join("\n");
      expect(politicas).not.toContain("contextClubId");
    }
  });

  it("no decide el dueño en el webchat", () => {
    const wc = read(WEBCHAT);
    // Se guarda y se documenta como contexto; no entra en ownerFields ni
    // en ownerWhere ni en la resolución.
    expect(wc).toContain("contextClubId");
    const resolver = wc.slice(wc.indexOf("export async function resolveWebchatOwner"));
    expect(resolver).not.toMatch(/contextClubId[^\n]*(owner|APPROVED|withOwnerRls)/);
  });

  it("ni se usa como filtro de acceso en el endpoint público", () => {
    const chat = read(RUTA_CHAT);
    // Se desestructura de resolveWebchatOwner y se reenvía a
    // openWebchatSession, que lo guarda. Nada más: no fija ningún contexto
    // de RLS, no filtra ninguna consulta y no se compara con nada.
    expect(chat).not.toMatch(/withPublicClubRls\(\s*contextClubId/);
    expect(chat).not.toMatch(/withOwnerRls\([^)]*contextClubId/);
    expect(chat).not.toMatch(/contextClubId\s*(===|!==|==)/);
    expect(chat).not.toMatch(/where:[^}]*contextClubId/);
    // El catálogo se lee con el club del slug, que es el que se validó.
    expect(chat).toContain("withPublicClubRls(club.id,");
  });

  it("y las páginas públicas ni lo mencionan", () => {
    for (const f of [PAGINA_CLUB, PAGINA_RRPP]) {
      expect(read(f)).not.toMatch(/contextClubId\s*[:=]/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 5 · Lo que el visitante tiene que seguir viendo
// ════════════════════════════════════════════════════════════════════

describe("5 · el perfil del club sigue enseñando lo mismo", () => {
  const club = read(PAGINA_CLUB);

  it("marca: logo, portada y los cuatro colores", () => {
    for (const campo of [
      "brand?.logoUrl",
      "brand.coverImageUrl",
      "brand?.primaryColor",
      "brand?.backgroundColor",
      "brand?.textColor",
      "brand?.borderRadius",
      "brand?.fontFamily",
    ]) {
      expect(club).toContain(campo);
    }
  });

  it("eventos futuros y publicables, con su precio vigente", () => {
    expect(club).toContain('status: { in: ["ACTIVE", "SOLD_OUT"] }');
    expect(club).toContain("startsAt: { gte:");
    expect(club).toContain("prices: { where: { isCurrent: true } }");
    expect(club).toContain("club.events.map");
  });

  it("VIP activos, ordenados", () => {
    expect(club).toContain("isActive: true");
    expect(club).toContain('orderBy: { sortOrder: "asc" }');
    expect(club).toContain("club.vipOptions.map");
  });

  it("el enlace de compra de Fourvenues, tal cual", () => {
    // Nunca se compone una URL: se usa la que el club tiene guardada.
    expect(club).toContain("checkoutUrl: event.ticketUrl");
  });

  it("y el webchat sigue colgado del club", () => {
    expect(club).toContain("club.botEnabled");
    expect(club).toContain("<ChatWidget");
  });
});

describe("5 bis · el perfil del RRPP sigue enseñando lo mismo", () => {
  const rrpp = read(PAGINA_RRPP);

  it("portada, avatar, bio y ciudad", () => {
    for (const campo of ["promoter.coverImageUrl", "promoter.photoUrl", "promoter.bio", "promoter.showCity"]) {
      expect(rrpp).toContain(campo);
    }
  });

  it("instagram y whatsapp solo si él lo ha activado", () => {
    expect(rrpp).toContain("promoter.showInstagram ? promoter.instagram : null");
    expect(rrpp).toContain("promoter.showWhatsapp ? promoter.whatsapp : null");
  });

  it("solo los clubs con el alta aprobada", () => {
    expect(rrpp).toContain('status: "APPROVED"');
    expect(rrpp).toContain("clubNames");
  });

  it("las noches futuras, ordenadas y con precio", () => {
    expect(rrpp).toContain('status: { in: ["ACTIVE", "SOLD_OUT"] }');
    expect(rrpp).toContain("prices: { where: { isCurrent: true } }");
    expect(rrpp).toContain("startsAt: { gte: desde }");
  });

  it("la URL de Fourvenues del RRPP, con la prioridad de §50", () => {
    expect(rrpp).toContain("resolveCheckoutUrl({");
    expect(rrpp).toContain("promoterCheckoutUrl: pe.checkoutUrl ?? promoter.fourvenuesUrl");
  });

  it("el acento de marca del club principal", () => {
    expect(rrpp).toContain("primaryClub?.brand?.primaryColor");
  });

  it("y el webchat, con su slug para que el bot hable en su nombre", () => {
    expect(rrpp).toContain("promoterSlug={promoter.slug}");
    expect(rrpp).toContain("<ChatWidget");
  });
});

// ════════════════════════════════════════════════════════════════════
// 6 · El canal sigue siendo la puerta de entrada
// ════════════════════════════════════════════════════════════════════

describe("6 · el webchat entra por Channel", () => {
  const wc = read(WEBCHAT);

  it("una sesión empieza resolviendo el canal del dueño", () => {
    const abrir = wc.slice(wc.indexOf("export function openWebchatSession"));
    const canal = abrir.indexOf("getOrCreateWebchatChannel(tx, owner)");
    const cliente = abrir.indexOf("tx.customer.upsert");
    expect(canal).toBeGreaterThan(-1);
    expect(cliente).toBeGreaterThan(canal);
  });

  it("un canal WEBCHAT por dueño, no uno por conversación", () => {
    expect(wc).toContain("const where = { ...channelWhere(owner), type: WEBCHAT };");
  });

  it("el cliente tiene alcance de canal", () => {
    expect(wc).toContain("channelId_externalUserHash");
  });

  it("y todo cuelga de ahí con el dueño derivado, nunca del cliente", () => {
    expect(wc).toContain("...ownerFields(owner)");
    expect(wc).not.toContain("args.ownerType");
  });
});

// ════════════════════════════════════════════════════════════════════
// 7 · La beta no está bloqueada por el paywall
// ════════════════════════════════════════════════════════════════════

describe("7 · beta cerrada: el asistente no se cobra ni se corta", () => {
  const billing = read(BILLING);

  it("hay un interruptor con nombre propio", () => {
    expect(billing).toContain("export const BETA_CERRADA: boolean = true;");
    expect(billing).toContain("export function assistantAvailable(");
  });

  it("y mientras esté encendido, el asistente está disponible", () => {
    const fn = billing.slice(billing.indexOf("export function assistantAvailable("));
    expect(fn.slice(0, 200)).toContain("if (BETA_CERRADA) return true;");
  });

  it("el endpoint público ya no corta por entitlement", () => {
    const chat = read(RUTA_CHAT);
    expect(chat).not.toContain('hasFeature(subscription, "ai_assistant")');
    expect(chat).toContain("assistantAvailable(subscription)");
  });

  it("ningún archivo del flujo público bloquea por ai_assistant", () => {
    for (const f of [PAGINA_CLUB, PAGINA_RRPP, RUTA_CHAT, WEBCHAT, "src/components/chat-widget.tsx"]) {
      expect(read(f)).not.toContain('hasFeature(');
    }
  });

  it("pero la infraestructura de suscripción sigue entera", () => {
    // No se borra nada: cuando la beta acabe, BETA_CERRADA pasa a false y
    // el cobro entra sin reescribir ninguna comprobación.
    for (const simbolo of [
      "export function hasFeature(",
      "export function isEntitled(",
      "export function limitsFor(",
      "export function withinAiQuota(",
      "export const PLANS",
      "export const TRIAL_DAYS",
    ]) {
      expect(billing).toContain(simbolo);
    }
    expect(read("src/packages/db/subscriptions.ts")).toContain("export async function getSubscriptionState(");
  });

  it("y no se ha inventado un plan BETA que nadie puede contratar", () => {
    const planes = billing.slice(billing.indexOf("export const PLANS"), billing.indexOf("export const DEFAULT_PLAN_BY_AUDIENCE"));
    expect(planes).not.toContain("BETA");
  });

  it("el panel del RRPP dice lo mismo que el endpoint", () => {
    // Que el bot conteste y el panel ponga «Off» sería peor que cualquiera
    // de las dos cosas por separado.
    const home = read("src/app/(dashboard)/promoter/home/page.tsx");
    expect(home).toContain("assistantAvailable(subscription)");
    expect(home).toContain("const ofrecerPlanes = !BETA_CERRADA;");
  });
});

// ════════════════════════════════════════════════════════════════════
// 8 · La transacción, que es lo que hace que nada de esto sea teórico
// ════════════════════════════════════════════════════════════════════

describe("8 · un contexto de club por club, y ninguna consulta suelta", () => {
  it("el perfil del RRPP no intenta fijar varios clubs a la vez", () => {
    const rrpp = read(PAGINA_RRPP);
    // No existe una variable de sesión que signifique «estos tres». Un
    // `clubId: { in: [...] }` dentro de un solo contexto solo devolvería
    // las filas del club fijado, y en silencio.
    expect(rrpp).toContain("clubIds.map((clubId) =>");
    expect(rrpp).not.toMatch(/withPublicClubRls\([^)]*\{\s*in:/);
  });

  it("las lecturas de un mismo contexto van juntas, no en transacciones sueltas", () => {
    expect(read(PAGINA_CLUB)).toContain("Promise.all([");
    expect(read(RUTA_CHAT)).toContain("Promise.all([");
  });

  it("los dos perfiles públicos siguen revalidando cada 60 s", () => {
    for (const f of [PAGINA_CLUB, PAGINA_RRPP]) {
      expect(read(f)).toContain("export const revalidate = 60;");
    }
  });

  it("y no se duplican las consultas entre generateMetadata y la página", () => {
    // Las dos llaman al mismo cargador. Sin `cache` serían dos
    // transacciones por visita en la página más visitada del producto.
    for (const f of [PAGINA_CLUB, PAGINA_RRPP]) {
      expect(read(f)).toContain('import { cache } from "react";');
      expect(read(f)).toMatch(/const load\w+ = cache\(/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 8 bis · El panel del RRPP, que tenía el mismo patrón
// ════════════════════════════════════════════════════════════════════

describe("8 bis · el panel del RRPP ya no lee por include", () => {
  const home = read("src/app/(dashboard)/promoter/home/page.tsx");

  it("la raíz global solo toca `promoters` y `clubs`", () => {
    expect(modelosGlobales(home)).toEqual(["club", "promoter"]);
  });

  it("sus altas y sus noches elegidas, en contexto de PROMOTER", () => {
    expect(home).toMatch(/withOwnerRls\(\s*\{\s*type:\s*"PROMOTER",\s*promoterId:\s*promoter\.id\s*\}/);
    expect(home).toContain("tx.promoterClub.findMany");
    expect(home).toContain("tx.promoterEvent.findMany");
  });

  it("y los eventos de cada club, en contexto de ese club", () => {
    expect(home).toContain("withPublicClubRls(clubId,");
  });

  it("sin include anidado desde prisma.promoter", () => {
    expect(home).not.toMatch(/prisma\.promoter\.findUnique\([^)]*include/s);
  });
});

// ════════════════════════════════════════════════════════════════════
// 9 · Y la suite de SQL que prueba el comportamiento de verdad
// ════════════════════════════════════════════════════════════════════

describe("9 · el comportamiento está probado contra PostgreSQL", () => {
  const sql = read("prisma/migrations/manual/tests/public-flow-tests.sql");

  it("comprueba primero que el rol está sujeto a RLS", () => {
    // Sin esta sonda, un superusuario haría pasar la suite entera sin
    // probar nada: ve todas las filas siempre.
    expect(sql).toContain("NO está sujeto a RLS y esta suite no prueba nada");
  });

  it("demuestra el include vacío", () => {
    expect(sql).toContain("el include vuelve VACÍO sin dar error");
  });

  it("demuestra el arreglo", () => {
    expect(sql).toContain("en contexto PROMOTER el alta se ve → dueño PROMOTER");
  });

  it("falla de verdad si algo falla", () => {
    expect(sql).toContain("RAISE EXCEPTION 'public-flow-tests: % casos fallidos");
  });

  it("y está en la pipeline", () => {
    expect(read("scripts/pg-pipeline.sh")).toContain("public-flow-tests.sql");
  });
});
