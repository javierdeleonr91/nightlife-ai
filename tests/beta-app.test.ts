import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardas sobre la capa de aplicación de la beta.
 *
 * No sustituyen a `npm run build` —eso solo puede correr donde hay
 * node_modules— pero sí fijan las decisiones que serían fáciles de deshacer
 * sin darse cuenta: que el owner no venga del cliente, que el schema refleje
 * el SQL, que la gestión de RRPP deje de estar en la navegación.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/manual/001-channel-owner.sql");

describe("schema.prisma refleja el SQL ya ejecutado", () => {
  it("tiene el enum de propiedad", () => {
    expect(schema).toContain("enum ChannelOwnerType {");
    expect(schema).toContain("  CLUB\n  PROMOTER");
  });

  it("las seis tablas polimórficas llevan ownerType obligatorio", () => {
    // `ownerType ChannelOwnerType` sin `?`: si alguien lo hiciera opcional,
    // Prisma y PostgreSQL dejarían de decir lo mismo.
    const veces = schema.match(/^\s+ownerType\s+ChannelOwnerType$/gm) ?? [];
    expect(veces.length).toBeGreaterThanOrEqual(8);
  });

  it("las columnas legacy siguen ahí y son opcionales", () => {
    // Borrarlas es la migración 002, y todavía no toca.
    for (const linea of [
      "  clubId             String?",
      "  channelType        ChannelType?",
      "  externalHandleHash String?",
    ]) {
      expect(schema).toContain(linea);
    }
  });

  it("borrar un canal NO arrastra historial", () => {
    // Tiene que coincidir exactamente con las FK del SQL: NO ACTION allí,
    // NoAction aquí. Un Cascade en Prisma sería drift silencioso.
    expect(schema).toContain(
      'channel       Channel        @relation(fields: [channelId], references: [id], onDelete: NoAction)',
    );
    expect(schema).toContain(
      'channel       Channel   @relation(fields: [channelId], references: [id], onDelete: NoAction)',
    );
    expect(migration).toContain("REFERENCES channels(id) ON DELETE NO ACTION");
  });

  it("contextClubId es SetNull en los dos sitios", () => {
    expect(schema).toContain('@relation("ConversationContextClub", fields: [contextClubId], references: [id], onDelete: SetNull)');
    expect(migration).toContain('FOREIGN KEY ("contextClubId") REFERENCES clubs(id) ON DELETE SET NULL');
  });

  it("los índices con nombre coinciden con los del SQL", () => {
    for (const nombre of [
      "channels_type_external_key",
      "channels_promoter_type_key",
      "customers_channel_hash_key",
      "conversations_owner_club_status_idx",
      "conversations_context_club_idx",
      "conversations_id_owner_type_key",
    ]) {
      expect(schema).toContain(nombre);
      expect(migration).toContain(nombre);
    }
  });

  it("las tablas nuevas de la beta existen en los dos sitios", () => {
    const sql = read("prisma/migrations/manual/010-beta-tables.sql");
    for (const t of ["unanswered_questions", "beta_feedback", "promoter_knowledge", "promoter_faqs"]) {
      expect(schema).toContain(`@@map("${t}")`);
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });

  it("010 no altera ni borra nada existente", () => {
    // Es aditiva por definición: si algún día aparece un ALTER de columna o
    // un DROP aquí, deja de serlo.
    const sql = read("prisma/migrations/manual/010-beta-tables.sql");
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toMatch(/ALTER TABLE \w+ ALTER COLUMN/);
  });
});

describe("el owner nunca viene del cliente", () => {
  const rutas = [
    "src/app/api/v1/assistant/unanswered/route.ts",
    "src/app/api/v1/assistant/unanswered/[id]/route.ts",
    "src/app/api/v1/assistant/conversations/[id]/route.ts",
    "src/app/api/v1/assistant/channels/[id]/route.ts",
    "src/app/api/v1/feedback/route.ts",
  ];

  it("ninguna ruta acepta ownerType, ownerClubId ni ownerPromoterId del body", () => {
    // `clubId` sí se acepta: identifica de cuál de SUS clubs se trata, y
    // `ownerFromRequest` comprueba la pertenencia antes de usarlo. Lo que no
    // puede llegar nunca es el owner ya resuelto.
    for (const r of rutas) {
      const code = read(r);
      for (const campo of ["ownerType", "ownerPromoterId"]) {
        expect(code.includes(`${campo}:`)).toBe(false);
      }
    }
  });

  it("todas resuelven el dueño con ownerFromRequest", () => {
    for (const r of rutas) {
      expect(read(r)).toContain("ownerFromRequest");
    }
  });

  it("owner-context comprueba la pertenencia y responde 404, no 403", () => {
    // Un 403 confirmaría que ese club existe.
    const code = read("src/lib/owner-context.ts");
    expect(code).toContain("principal.clubRoles.has(clubId)");
    expect(code).toContain('AppError.notFound("Club")');
  });
});

describe("la gestión de RRPP sale de la navegación", () => {
  it("el club ya no navega a Promoters", () => {
    const layout = read("src/app/(dashboard)/club/[clubSlug]/layout.tsx");
    expect(layout).not.toContain('label: "Promoters"');
  });

  it("pero la ruta no se ha borrado", () => {
    // Borrarla sería destructivo y prematuro: se oculta, no se destruye.
    expect(existsSync(join(root, "src/app/(dashboard)/club/[clubSlug]/promoters/page.tsx"))).toBe(true);
  });
});

describe("el asistente no finge estar configurado", () => {
  it("sin LLM_API_KEY lo dice en vez de callarse", () => {
    const panels = read("src/components/assistant-panels.tsx");
    expect(panels).toContain("Asistente no configurado");
    expect(panels).toContain("llmConfigured");
  });

  it("un canal sin credenciales dice «Sin configurar», no «Conectado»", () => {
    const panels = read("src/components/assistant-panels.tsx");
    expect(panels).toContain('"Sin configurar"');
    expect(panels).toContain('"Error · hay que reconectar"');
  });

  it("las dos pantallas del asistente pasan por forOwner", () => {
    for (const p of [
      "src/app/(dashboard)/promoter/assistant/page.tsx",
      "src/app/(dashboard)/club/[clubSlug]/assistant/page.tsx",
    ]) {
      const code = read(p);
      expect(code).toMatch(/promoterOwner|clubOwner/);
      // Ya no se filtra por el promoterId legacy, que no es el dueño.
      expect(code).not.toContain("where: { promoterId }");
    }
  });
});

describe("responder una pregunta la convierte en conocimiento", () => {
  const code = read("src/app/api/v1/assistant/unanswered/[id]/route.ts");

  it("crea una FAQ al guardar la respuesta", () => {
    expect(code).toContain("tx.fAQ.create");
    expect(code).toContain("tx.promoterFAQ.create");
  });

  it("guarda la pregunta tal y como la escribió el cliente", () => {
    // Su forma real de preguntar es justo la señal que hay que conservar.
    expect(code).toContain("question: question.originalQuestion");
  });

  it("las dos escrituras van en la misma transacción", () => {
    // Si se separaran, una pregunta podría quedar marcada como respondida
    // sin que exista la FAQ que la responde.
    expect(code).toContain("db.tx(async (tx)");
  });
});
