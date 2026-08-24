import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardas sobre el SQL de propiedad y RLS.
 *
 * No sustituyen al ensayo contra Postgres real (eso está en
 * prisma/migrations/manual/tests/), pero sí impiden que alguien deshaga por
 * descuido una de las decisiones que sostienen el aislamiento entre
 * inquilinos. Son baratas y corren en cada build.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const migration = read("prisma/migrations/manual/001-channel-owner.sql");
const rollback = read("prisma/migrations/manual/001-channel-owner-rollback.sql");
const rls = read("prisma/rls-owner.sql");
const verification = read("prisma/migrations/manual/verification.sql");
const forOwnerDoc = read("docs/forOwner.md");
// Desde esta fase el helper existe de verdad en src. El doc se queda porque
// explica el porqué, pero lo que se comprueba es el código que se ejecuta.
const forOwnerSrc = read("src/packages/db/owner.ts");

describe("RLS: contextClubId nunca da acceso", () => {
  it("no aparece en ninguna política", () => {
    // Es «de qué se habla», no «de quién es». Si entrara en una política, un
    // club leería los mensajes privados que un cliente manda a un RRPP solo
    // porque en algún momento se mencionó el nombre del club.
    // Solo el cuerpo del CREATE POLICY: el comentario del final del archivo
    // sí nombra contextClubId, precisamente para explicar por qué no está.
    const policyBody = rls.slice(rls.indexOf("CREATE POLICY"), rls.indexOf("END LOOP"));
    expect(policyBody).not.toContain("contextClubId");
  });

  it("verification.sql comprueba que no se cuele en el futuro", () => {
    expect(verification).toContain("contextClubId%");
  });

  it("los triggers de inmutabilidad lo dejan fuera a propósito", () => {
    const fn = migration.slice(
      migration.indexOf("FUNCTION nl_owner_immutable"),
      migration.indexOf("FUNCTION nl_channel_owner_immutable"),
    );
    expect(fn).not.toContain("contextClubId");
  });
});

describe("RLS: las políticas fallan cerrado", () => {
  it("cada rama exige que la columna no sea NULL", () => {
    // `NULL = 'algo'` no es falso en SQL: es NULL, que tampoco es verdadero.
    // Sin el IS NOT NULL delante, una fila de promoter sería invisible para
    // todo el mundo, incluido su dueño, y no daría ningún error.
    expect(rls).toContain("IS NOT NULL");
  });

  it("toda política lleva WITH CHECK", () => {
    // Sin WITH CHECK se lee con aislamiento pero se pueden **escribir** filas
    // con el dueño de otro.
    expect(rls).toContain("WITH CHECK");
  });

  it("usa current_setting con missing_ok = true", () => {
    // Con `false`, no tener la variable fijada lanzaría una excepción en vez
    // de devolver cero filas. Fallar cerrado es devolver nada, no reventar.
    expect(rls).toContain("current_setting('app.current_club_id', true)");
    expect(rls).toContain("current_setting('app.current_promoter_id', true)");
  });

  it("fuerza RLS también para el dueño de las tablas", () => {
    expect(rls).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("las políticas van dirigidas a nl_app, no a PUBLIC", () => {
    // A PUBLIC alcanzarían a todo rol presente y futuro, incluidos los que
    // Supabase cree por su cuenta.
    expect(rls).toContain("TO nl_app");
  });

  it("rls-owner comprueba que nl_app no se salte RLS antes de crear nada", () => {
    expect(rls).toContain("rolbypassrls");
  });
});

describe("forOwner (src): la variable no puede sobrevivir a la transacción", () => {
  it("fija SIEMPRE las dos, la que no toca a cadena vacía", () => {
    // Sin esto, una conexión del pooler donde alguien dejó
    // app.current_club_id a nivel de sesión se hereda tal cual.
    expect(forOwnerSrc).toContain('const clubId = owner.type === "CLUB" ? owner.clubId : "";');
    expect(forOwnerSrc).toContain('const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";');
  });

  it("las dos con el tercer argumento en true", () => {
    expect(forOwnerSrc).toContain("set_config('app.current_club_id',     ${clubId},     true)");
    expect(forOwnerSrc).toContain("set_config('app.current_promoter_id', ${promoterId}, true)");
  });

  it("nunca usa false", () => {
    expect(forOwnerSrc).not.toContain(", false)");
  });

  it("todo va dentro de prisma.$transaction", () => {
    expect(forOwnerSrc).toContain("prisma.$transaction");
  });

  it("exactamente dos set_config", () => {
    expect(forOwnerSrc.match(/set_config\('app\./g)?.length).toBe(2);
  });

  it("el dueño se deriva del Principal, nunca del cliente", () => {
    expect(forOwnerSrc).toContain("export function ownerFor(principal: Principal");
    expect(forOwnerSrc).toContain("principal.promoterId !== requested.promoterId");
    expect(forOwnerSrc).toContain('if (!principal.clubRoles.has(requested.clubId)) throw AppError.notFound("Club");');
  });

  it("forTenant sobrevive como puente sobre forOwner(CLUB)", () => {
    expect(forOwnerSrc).toContain("export function forOwnerFromTenant");
    expect(forOwnerSrc).toContain('{ type: "CLUB", clubId }');
  });

  it("los repositorios llevan el where de dueño además de RLS", () => {
    // Redundante a propósito: si esto corriera contra una conexión sin
    // políticas, el filtro seguiría puesto.
    expect(forOwnerSrc).toContain("export function ownerWhere");
    expect(forOwnerSrc).toContain("export function channelWhere");
  });
});

describe("forOwner (doc): el porqué sigue documentado", () => {
  it("usa set_config con el tercer argumento en true", () => {
    expect(forOwnerDoc).toContain("set_config('app.current_club_id',     ${clubId},     true)");
    expect(forOwnerDoc).toContain("set_config('app.current_promoter_id', ${promoterId}, true)");
  });

  it("fija SIEMPRE las dos, la que no toca a cadena vacía", () => {
    // Es lo que protege de una conexión donde alguien dejó una variable
    // fijada a nivel de sesión: no fijarla sería heredarla.
    expect(forOwnerDoc).toContain('owner.type === "CLUB"     ? owner.clubId     : ""');
    expect(forOwnerDoc).toContain('owner.type === "PROMOTER" ? owner.promoterId : ""');
  });

  it("nunca usa false", () => {
    // `false` = la variable se queda pegada a la conexión del pooler y el
    // siguiente inquilino hereda el club anterior.
    const code = forOwnerDoc.slice(forOwnerDoc.indexOf("```ts"));
    expect(code).not.toContain(", false)");
  });

  it("todo pasa por $transaction", () => {
    expect(forOwnerDoc).toContain("prisma.$transaction");
  });

  it("fija exactamente dos set_config por transacción", () => {
    // Alguien con los dos papeles vería en una misma consulta filas de dos
    // dueños distintos si ambas llevaran valor; por eso una va vacía.
    const fn = forOwnerDoc.slice(
      forOwnerDoc.indexOf("export function withOwnerRls"),
      forOwnerDoc.indexOf("export function forOwner"),
    );
    // Exactamente dos llamadas: una por variable, ni más ni menos.
    expect(fn.match(/set_config\('app\./g)?.length).toBe(2);
  });

  it("el dueño se deriva del Principal, no del cliente", () => {
    expect(forOwnerDoc).toContain("export function ownerFor(principal: Principal");
    expect(forOwnerDoc).toContain("principal.promoterId !== requested.promoterId");
  });

  it("documenta que un rol superusuario invalida todo", () => {
    expect(forOwnerDoc).toContain("NOSUPERUSER");
    expect(forOwnerDoc).toContain("BYPASSRLS");
  });

  it("mantiene forTenant como puente legacy sobre forOwner(CLUB)", () => {
    expect(forOwnerDoc).toContain("forOwnerFromTenant");
    expect(forOwnerDoc).toContain('{ type: "CLUB", clubId }');
  });
});

describe("triggers de propiedad", () => {
  // Los 16, por nombre exacto. Contar con LIKE 'nl_%' no vale: en SQL el
  // guion bajo es un comodín y casa con `nlikesel`, una función interna de
  // PostgreSQL. Ese despiste me dio un falso «2 funciones sin borrar».
  const triggers = [
    "nl_channel_immutable_t",
    "nl_customer_channel_t", "nl_customer_immutable_t", "nl_customer_owner_t",
    "nl_conversation_channel_t", "nl_conversation_immutable_t", "nl_conversation_owner_t",
    "nl_message_conversation_t", "nl_message_immutable_t", "nl_message_owner_t",
    "nl_followup_conversation_t", "nl_followup_immutable_t", "nl_followup_owner_t",
    "nl_ailog_conversation_t", "nl_ailog_immutable_t", "nl_ailog_owner_t",
  ];
  const funciones = [
    "nl_customer_owner", "nl_conversation_owner", "nl_child_owner_from_conversation",
    "nl_owner_immutable", "nl_channel_owner_immutable",
    "nl_channel_ref_immutable", "nl_conversation_ref_immutable",
  ];

  it("la migración crea los dieciséis", () => {
    for (const t of triggers) expect(migration).toContain(`CREATE TRIGGER ${t}`);
  });

  it("cubre las seis tablas polimórficas", () => {
    for (const t of ["channels", "customers", "conversations", "messages",
                     "follow_ups", "ai_request_logs"]) {
      expect(migration).toContain(`ON ${t} FOR EACH ROW`);
    }
  });

  it("el rollback los quita todos", () => {
    // Si se dejara uno, el propio rollback se estrellaría contra la
    // inmutabilidad al restituir los valores legacy.
    for (const t of triggers) expect(rollback).toContain(`DROP TRIGGER IF EXISTS ${t}`);
  });

  it("el rollback quita también las siete funciones", () => {
    for (const f of funciones) expect(rollback).toContain(`DROP FUNCTION IF EXISTS ${f}()`);
  });

  it("el rollback los quita ANTES de tocar las filas", () => {
    expect(rollback.indexOf("DROP TRIGGER IF EXISTS nl_channel_immutable_t")).toBeLessThan(
      rollback.indexOf("UPDATE conversations   SET"),
    );
  });

  it("son BEFORE: corrigen o abortan antes de escribir", () => {
    expect(migration).not.toContain("AFTER INSERT OR UPDATE OF");
    const creates = migration.match(/CREATE TRIGGER nl_\w+\s+BEFORE/g) ?? [];
    expect(creates.length).toBe(triggers.length);
  });

  it("ninguna función de trigger es SECURITY DEFINER", () => {
    // Lo serían sus SELECT internos también, y dejarían de pasar por RLS.
    const step12 = migration.slice(migration.indexOf("FUNCTION nl_customer_owner"));
    expect(step12).not.toContain("SECURITY DEFINER");
  });

  it("derivan cuando falta el dueño y rechazan cuando difiere", () => {
    const fn = migration.slice(
      migration.indexOf("FUNCTION nl_child_owner_from_conversation"),
      migration.indexOf("12.3 Inmutabilidad"),
    );
    expect(fn).toContain('IF NEW."ownerType" IS NULL THEN');
    expect(fn).toContain("ELSIF");
    expect(fn).toContain("RAISE EXCEPTION");
  });

  it("un AiRequestLog sin conversación exige owner explícito", () => {
    // No hay de dónde derivarlo; inventarlo sería peor que rechazarlo.
    expect(migration).toContain('IF NEW."conversationId" IS NULL THEN');
  });

  it("congela también el puntero al padre", () => {
    expect(migration).toContain("FUNCTION nl_channel_ref_immutable");
    expect(migration).toContain("FUNCTION nl_conversation_ref_immutable");
  });

  it("verification.sql usa listas exactas, no LIKE", () => {
    for (const t of triggers) expect(verification).toContain(`'${t}'`);
    for (const f of funciones) expect(verification).toContain(`'${f}'`);
  });
});

describe("borrar un canal no destruye historial", () => {
  it("las dos FK hacia channels son NO ACTION", () => {
    // Desconectar es CONNECTED → DISCONNECTED. Borrar la fila es un
    // accidente, y un accidente no puede llevarse las conversaciones.
    expect(migration).toContain(
      'FOREIGN KEY ("channelId") REFERENCES channels(id) ON DELETE NO ACTION',
    );
    const noAction = migration.match(/REFERENCES channels\(id\) ON DELETE NO ACTION/g) ?? [];
    expect(noAction.length).toBe(2);
  });

  it("ninguna FK hacia channels es CASCADE", () => {
    expect(migration).not.toContain("REFERENCES channels(id) ON DELETE CASCADE");
  });

  it("las FK de propiedad sí son CASCADE: el dueño borra lo suyo", () => {
    for (const c of ["customers_owner_club_fkey", "conversations_owner_promoter_fkey",
                     "follow_ups_owner_club_fkey", "ai_request_logs_owner_promoter_fkey"]) {
      expect(migration).toContain(c);
    }
  });

  it("verification.sql comprueba la semántica de borrado en el catálogo", () => {
    expect(verification).toContain("confdeltype");
  });
});

describe("el rollback es real", () => {
  it("aborta si hay datos de promoter en cualquiera de las seis", () => {
    expect(rollback).toContain("filas de promoter");
    for (const t of ["channels", "customers", "conversations", "messages",
                     "follow_ups", "ai_request_logs"]) {
      expect(rollback).toContain(`'${t}'`);
    }
  });

  it("restaura las políticas RLS legacy basadas en clubId", () => {
    // Dejar RLS activo sin política sería negar el acceso a todo el mundo
    // devolviendo cero filas sin decir por qué.
    expect(rollback).toContain('USING ("clubId" = current_setting');
  });

  it("comprueba al final que ninguna tabla quedó sin política", () => {
    expect(rollback).toContain("se quedó con RLS activo y sin política legacy");
  });
});

describe("nadie puede correr esto a ciegas", () => {
  it("la migración aborta si su sesión está sujeta a RLS", () => {
    // Si lo estuviera, los UPDATE de relleno afectarían a 0 filas sin avisar
    // y las verificaciones pasarían sobre una vista vacía.
    expect(migration).toContain("row_security");
    expect(migration).toContain("está sujeto a RLS");
  });

  it("el rollback también", () => {
    expect(rollback).toContain("está sujeto a RLS");
  });

  it("verification.sql también", () => {
    expect(verification).toContain("este informe saldría verde sobre una vista vacía");
  });

  it("verification.sql termina con excepción si algo falla", () => {
    // Con ON_ERROR_STOP=1 eso es un exit code != 0, no un NOTICE que nadie lee.
    expect(verification).toContain("RAISE EXCEPTION '% comprobaciones fallidas");
  });
});

describe("las suites SQL fallan de verdad", () => {
  const triggerTests = read("prisma/migrations/manual/tests/trigger-tests.sql");
  const poolingTests = read("prisma/migrations/manual/tests/rls-pooling-tests.sql");

  it("trigger-tests acumula y lanza excepción", () => {
    expect(triggerTests).toContain("RAISE EXCEPTION 'trigger-tests: % casos fallidos");
  });

  it("trigger-tests no deja rastro en la base", () => {
    expect(triggerTests.trimEnd().endsWith("ROLLBACK;")).toBe(true);
  });

  it("pooling-tests acumula entre transacciones y lanza excepción", () => {
    expect(poolingTests).toContain("CREATE TEMP TABLE _fallos");
    expect(poolingTests).toContain("RAISE EXCEPTION 'rls-pooling-tests: % casos fallidos");
  });

  it("pooling-tests se niega a correr con un rol que se salte RLS", () => {
    expect(poolingTests).toContain("rolbypassrls");
    expect(poolingTests).toContain("no prueba nada como");
  });

  it("pooling-tests contamina la conexión a propósito", () => {
    // Sin reproducir la contaminación, la prueba de las dos variables no
    // demostraría nada.
    expect(poolingTests).toContain("set_config('app.current_club_id', 'club_mon', false)");
  });
});

describe("la migración es aditiva", () => {
  it("no borra ninguna columna", () => {
    expect(migration).not.toContain("DROP COLUMN");
  });

  it("va entera en una transacción", () => {
    // Un solo par BEGIN/COMMIT: si alguien parte la migración en dos
    // transacciones, un fallo a mitad deja la base a medio migrar.
    expect(migration.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("aborta si una verificación crítica falla", () => {
    expect(migration).toContain("RAISE EXCEPTION");
  });
});
