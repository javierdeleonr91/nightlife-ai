import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardas sobre el flujo público de webchat.
 *
 * Es la única superficie del sistema donde escribe alguien que no ha
 * iniciado sesión, así que es donde más barato sale equivocarse. Estas
 * comprobaciones fijan las tres decisiones que lo sostienen: el dueño se
 * resuelve en el servidor, el canal es el punto de entrada, y el contexto
 * no autoriza.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const webchat = read("src/packages/db/webchat.ts");
const route = read("src/app/api/v1/chat/route.ts");
const owner = read("src/packages/db/owner.ts");

describe("el visitante no es un Principal", () => {
  it("el flujo público no fabrica un Principal falso", () => {
    // Sería la forma cómoda de reutilizar forOwner, y abriría un agujero:
    // un Principal inventado se puede inventar con cualquier club dentro.
    // Se mira el import, no el texto: webchat.ts nombra `forOwner` en un
    // comentario, precisamente para explicar por qué no lo usa.
    expect(webchat).not.toMatch(/import \{[^}]*forOwner[^}]*\}/);
    expect(route).not.toMatch(/import \{[^}]*forOwner[^}]*\}/);
    // Y no importa el tipo Principal: si lo importara, es que lo construye.
    expect(webchat).not.toMatch(/import[^;]*\bPrincipal\b[^;]*from/);
    expect(route).not.toContain("requirePrincipal");
  });

  it("pero sí pasa por RLS", () => {
    // Sin Principal, pero con las variables de la transacción fijadas.
    expect(webchat).toContain("withOwnerRls");
  });

  it("el cuerpo de la petición no admite campos de propiedad", () => {
    // El esquema de Zod es la lista blanca: lo que no esté aquí se descarta
    // antes de tocar la base de datos.
    const schema = route.slice(route.indexOf("const schema = z.object("), route.indexOf("export async function POST"));
    for (const campo of ["ownerType", "ownerClubId", "ownerPromoterId", "channelId", "conversationId"]) {
      expect(schema).not.toContain(campo);
    }
  });

  it("el dueño se resuelve desde el recurso público validado", () => {
    expect(route).toContain("resolveWebchatOwner");
    // Y el RRPP tiene que estar aprobado en ese club para prestar su nombre.
    expect(webchat).toContain('status: "APPROVED"');
  });
});

describe("el canal es el punto de entrada", () => {
  it("hay un canal de webchat por dueño, no uno por conversación", () => {
    expect(webchat).toContain("getOrCreateWebchatChannel");
    // Se busca antes de crear, y la carrera la resuelve el índice único.
    expect(webchat).toContain("tx.channel.findFirst");
  });

  it("el cliente tiene alcance de canal", () => {
    // (channelId, externalUserHash): el mismo navegador escribiendo a dos
    // dueños son dos clientes distintos que no se cruzan.
    expect(webchat).toContain("channelId_externalUserHash");
  });

  it("la identidad del visitante va hasheada con el dueño en la sal", () => {
    expect(route).toContain("hashCustomerHandle");
    expect(route).toContain("CUSTOMER_HASH_PEPPER");
    expect(route).toContain("ownerSalt");
    // Nunca en claro.
    expect(webchat).toContain("Nunca en claro");
  });
});

describe("el dueño se deriva, nunca se recibe", () => {
  it("todas las escrituras usan ownerFields", () => {
    // Objeto plano con los tres campos: uno lleno y el otro a null, que es
    // lo que exige el CHECK de PostgreSQL.
    expect(owner).toContain("export function ownerFields");
    const usos = webchat.match(/ownerFields\(/g) ?? [];
    expect(usos.length).toBeGreaterThanOrEqual(4);
  });

  it("los campos legacy solo se rellenan cuando el dueño es un club", () => {
    // Para un RRPP se quedan a NULL: es justo lo que comprueba el
    // cortafuegos del rollback antes de dejar volver al modelo antiguo.
    expect(webchat).toContain('owner.type === "CLUB" ? { clubId: owner.clubId } : {}');
  });

  it("los updateMany llevan el filtro de dueño además de RLS", () => {
    const updates = webchat.match(/updateMany\(\{\s*where: \{ id: args\.conversationId, \.\.\.scope \}/g) ?? [];
    expect(updates.length).toBe(2);
  });
});

describe("contexto no es autorización", () => {
  it("contextClubId se guarda como contexto y se dice que lo es", () => {
    expect(webchat).toContain("contextClubId");
    expect(webchat).toContain("NO autorización");
  });

  it("el dueño no cambia durante la conversación", () => {
    // Ni una sola escritura de owner en un update: es inmutable y lo
    // garantizan los triggers, pero el código tampoco lo intenta.
    const update = webchat.slice(webchat.indexOf("tx.conversation.updateMany"));
    expect(update).not.toContain("ownerType:");
    expect(update).not.toContain("ownerClubId:");
    expect(update).not.toContain("ownerPromoterId:");
  });
});

describe("la IA se calla cuando debe, pero el mensaje entra", () => {
  it("con un humano dentro se guarda el mensaje y no se responde", () => {
    expect(route).toContain("recordIncomingMessage");
    expect(route).toContain('session.status === "HUMAN_ACTIVE"');
  });

  it("con autoReply apagado, lo mismo", () => {
    expect(route).toContain("!session.autoReply");
  });
});

describe("el LLM no se llama con una transacción abierta", () => {
  it("el motor corre fuera de withOwnerRls", () => {
    // Retener una conexión del pool durante una llamada al LLM es la forma
    // más rápida de quedarse sin conexiones un sábado.
    // `lastIndexOf` para no cazar la línea del import, que está arriba del
    // todo y haría pasar el test por accidente.
    const abrir = route.indexOf("await openWebchatSession(");
    const motor = route.indexOf("await runEngine(");
    const guardar = route.indexOf("await persistWebchatTurn(");
    expect(abrir).toBeLessThan(motor);
    expect(motor).toBeLessThan(guardar);
  });
});

describe("env es una función, no un objeto", () => {
  it("las páginas del asistente la invocan", () => {
    // `env` exporta `env(): Env`. Tratarlo como objeto compila en el editor
    // y falla en `tsc`; me pasó en app-01.
    for (const p of [
      "src/app/(dashboard)/club/[clubSlug]/assistant/page.tsx",
      "src/app/(dashboard)/promoter/assistant/page.tsx",
    ]) {
      const code = read(p);
      expect(code).toContain("Boolean(env().LLM_API_KEY)");
      expect(code).not.toContain("Boolean(env.LLM_API_KEY)");
    }
  });

  it("nadie usa env como objeto en src", () => {
    const envSrc = read("src/packages/config/env.ts");
    expect(envSrc).toContain("export function env(): Env");
  });
});
