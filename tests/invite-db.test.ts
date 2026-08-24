import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * El canje contra un Postgres de verdad.
 *
 * Los tests de `invite.test.ts` comprueban las reglas (qué código vale, cuándo
 * caduca). Este comprueba la única parte que **no se puede razonar sin una base
 * de datos**: que dos canjes simultáneos del último uso no pasan los dos.
 *
 * Se ejecuta el mismo par de sentencias que emite Prisma —
 *
 *   UPDATE club_invites SET used_count = used_count + 1
 *    WHERE id = $1 AND used_count < $2      (con límite)
 *   UPDATE club_invites SET used_count = used_count + 1
 *    WHERE id = $1                          (ilimitado)
 *
 * — dentro de transacciones concurrentes reales. Lo que se está verificando es
 * una propiedad de Postgres bajo READ COMMITTED: la segunda transacción se
 * bloquea en la fila, y al desbloquearse vuelve a evaluar el WHERE contra la
 * versión ya confirmada. Si no se cumpliera, el diseño entero del canje sería
 * incorrecto y ningún test de lógica pura lo detectaría.
 *
 * Necesita un servidor. Sin `INVITE_DB_TEST_DSN` no se ejecuta, para que nadie
 * lo lance por accidente contra su base de producción.
 */

const DSN = process.env.INVITE_DB_TEST_DSN;
const enabled = Boolean(DSN);

/** Ejecuta SQL y devuelve la salida en crudo, sin adornos. */
function sql(statement: string): string {
  return execFileSync("psql", [DSN as string, "-v", "ON_ERROR_STOP=1", "-tAc", statement], {
    encoding: "utf8",
  }).trim();
}

/**
 * Lanza un canje en su propia conexión y devuelve si consumió un uso.
 *
 * El `pg_sleep` entre la lectura y la escritura ensancha a propósito la ventana
 * de carrera: sin él, las transacciones podrían no llegar a solaparse y el test
 * pasaría sin haber probado nada.
 */
function redeemConcurrently(
  inviteId: string,
  maxUses: number,
  count: number,
  /** Aplica la condición SIEMPRE, incluso con maxUses=0. Solo para demostrar el fallo. */
  forceCondition = false,
): Promise<boolean[]> {
  const condition = maxUses > 0 || forceCondition ? ` AND used_count < ${maxUses}` : "";
  const statement = `
    BEGIN;
    SELECT used_count FROM club_invites WHERE id = '${inviteId}';
    SELECT pg_sleep(0.25);
    UPDATE club_invites SET used_count = used_count + 1
     WHERE id = '${inviteId}'${condition};
    COMMIT;
  `;

  const runs = Array.from({ length: count }, () =>
    new Promise<boolean>((resolve) => {
      const child = spawn("psql", [DSN as string, "-v", "ON_ERROR_STOP=1", "-tAc", statement]);
      let out = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", () => {});
      // psql imprime «UPDATE 1» o «UPDATE 0»: eso es lo que dice si consumió.
      child.on("close", () => resolve(/UPDATE 1/.test(out)));
    }),
  );

  return Promise.all(runs);
}

function seedInvite(id: string, maxUses: number): void {
  // El código se deriva del id completo, no de sus ocho primeros caracteres:
  // «inv-loop-1» e «inv-loop-2» comparten prefijo y chocaban contra la
  // restricción de unicidad del propio test.
  const code = id.toUpperCase().replace(/[^A-Z0-9]/g, "");
  sql(`
    INSERT INTO club_invites (id, club_id, code, created_by_id, max_uses, used_count)
    VALUES ('${id}', 'club-1', '${code}', 'user-1', ${maxUses}, 0)
    ON CONFLICT (id) DO UPDATE SET used_count = 0, max_uses = ${maxUses};
  `);
}

function usedCount(id: string): number {
  return Number(sql(`SELECT used_count FROM club_invites WHERE id = '${id}';`));
}

describe("canje contra Postgres real", () => {
  if (!enabled) {
    it("se salta sin INVITE_DB_TEST_DSN", () => {
      // Visible a propósito: un test que se salta en silencio es un test que
      // nadie sabe que nunca corre.
      expect(enabled).toBe(false);
    });
    return;
  }

  beforeAll(() => {
    sql(`
      DROP TABLE IF EXISTS club_invites;
      CREATE TABLE club_invites (
        id           text PRIMARY KEY,
        club_id      text NOT NULL,
        code         text NOT NULL UNIQUE,
        created_by_id text NOT NULL,
        max_uses     integer NOT NULL DEFAULT 1,
        used_count   integer NOT NULL DEFAULT 0,
        revoked_at   timestamptz,
        expires_at   timestamptz
      );
    `);
  });

  it("maxUses=1: el primero entra, el segundo no", async () => {
    seedInvite("inv-one", 1);
    const results = await redeemConcurrently("inv-one", 1, 2);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(usedCount("inv-one")).toBe(1);
  });

  it("maxUses=2: entran dos, el tercero no", async () => {
    seedInvite("inv-two", 2);
    const results = await redeemConcurrently("inv-two", 2, 3);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(usedCount("inv-two")).toBe(2);
  });

  it("maxUses=0: entran todos y el contador los cuenta", async () => {
    seedInvite("inv-free", 0);
    const results = await redeemConcurrently("inv-free", 0, 5);
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(usedCount("inv-free")).toBe(5);
  });

  it("ocho peticiones simultáneas sobre maxUses=3 no pasan de tres", async () => {
    seedInvite("inv-race", 3);
    const results = await redeemConcurrently("inv-race", 3, 8);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(usedCount("inv-race")).toBe(3);
  });

  it("aplicar la condición a un ilimitado lo dejaría inservible", async () => {
    /*
     * Esto es lo que pasaría si `usageCondition` devolviera `{ lt: 0 }` en vez
     * de `null` para los códigos reutilizables: `used_count < 0` no se cumple
     * nunca, así que **no entraría nadie**.
     *
     * El test ejecuta a propósito la versión equivocada para dejar constancia
     * de qué se está evitando. Si alguien «simplifica» el ternario quitando la
     * rama del ilimitado, el test de arriba se pone rojo y este explica por qué.
     */
    seedInvite("inv-broken", 0);
    const results = await redeemConcurrently("inv-broken", 0, 3, true);
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(usedCount("inv-broken")).toBe(0);
  });

  it("nunca se pasa del límite, aunque se repita la carrera", async () => {
    for (const attempt of [1, 2, 3]) {
      seedInvite(`inv-loop-${attempt}`, 2);
      await redeemConcurrently(`inv-loop-${attempt}`, 2, 6);
      expect(usedCount(`inv-loop-${attempt}`)).toBeLessThanOrEqual(2);
    }
  });
});
