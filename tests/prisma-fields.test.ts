import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Los nombres de campo que se le piden a Prisma existen de verdad.
 *
 * Este test nace de un fallo concreto: una consulta pedía `Event.title` y el
 * modelo se llama `name`. Otra pedía `Message.body` y el campo es `content`.
 * Ninguno de los dos se veía en `dev`; los dos rompían `tsc`.
 *
 * `tsc` los caza, sí — pero solo el typecheck completo, que necesita
 * `node_modules` y el cliente de Prisma generado. Este test hace la misma
 * comprobación leyendo `schema.prisma` y el código fuente, sin instalar nada,
 * así que sirve de red en cualquier entorno y falla en cinco milisegundos.
 *
 * Cubre `select` e `include`, incluidos los anidados, siguiendo las relaciones
 * de un modelo al siguiente. No intenta validar `where` ni `orderBy`: ahí hay
 * operadores (`in`, `gte`, `AND`) y la gracia de este test es que no tenga
 * falsos positivos, porque un guard con ruido acaba desactivado.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── el esquema ────────────────────────────────────────────────────────

interface Field {
  readonly name: string;
  /** Modelo relacionado, si el campo es una relación. */
  readonly relatedModel: string | null;
}

function parseSchema(source: string): Map<string, Map<string, Field>> {
  const models = new Map<string, Map<string, Field>>();
  const modelNames = new Set<string>();

  for (const match of source.matchAll(/^model\s+(\w+)\s*\{/gm)) {
    modelNames.add(match[1] as string);
  }

  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = match[1] as string;
    const body = match[2] as string;
    const fields = new Map<string, Field>();

    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\/\/.*$/, "").replace(/^\s*\/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@") || line.startsWith("///")) continue;
      const fieldMatch = /^(\w+)\s+([\w[\]?]+)/.exec(line);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1] as string;
      const type = (fieldMatch[2] as string).replace(/[[\]?]/g, "");
      fields.set(fieldName, {
        name: fieldName,
        relatedModel: modelNames.has(type) ? type : null,
      });
    }

    models.set(name, fields);
  }

  return models;
}

/** `VIPOption` → `vIPOption`, que es como lo genera Prisma. */
function accessorFor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

// ── lectura del código ────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Devuelve el bloque `{...}` equilibrado que empieza en `open`. */
function balanced(text: string, open: number): string | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

interface Entry {
  readonly key: string;
  /** El bloque del valor, si el valor era un objeto. */
  readonly block: string | null;
}

/** Las claves de primer nivel de un bloque `{ ... }`. */
function entriesOf(block: string): Entry[] {
  const inner = block.slice(1, -1);
  const out: Entry[] = [];
  let depth = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (depth !== 0) continue;

    const rest = inner.slice(i);
    const match = /^(\w+)\s*:/.exec(rest);
    if (!match) continue;
    // Solo cuenta si empieza entrada: detrás hay principio de bloque o una coma.
    const before = inner.slice(0, i).replace(/\s+$/, "");
    if (before && !before.endsWith(",")) continue;

    const key = match[1] as string;
    const afterColon = i + match[0].length;
    const valueStart = inner.slice(afterColon).search(/\S/);
    const absolute = afterColon + (valueStart === -1 ? 0 : valueStart);
    const block2 = inner[absolute] === "{" ? balanced(inner, absolute) : null;
    out.push({ key, block: block2 });
    i = absolute + (block2?.length ?? 0);
  }

  return out;
}

/** Claves que son argumentos de Prisma, no campos del modelo. */
const ARGUMENT_KEYS = new Set([
  "select",
  "include",
  "where",
  "orderBy",
  "take",
  "skip",
  "cursor",
  "distinct",
  "by",
  "having",
  "_count",
  "_sum",
  "_avg",
  "_min",
  "_max",
  "omit",
]);

interface Problem {
  readonly file: string;
  readonly model: string;
  readonly field: string;
}

/** Valida un bloque `select`/`include` contra los campos de `model`. */
function checkProjection(
  block: string,
  model: string,
  schema: Map<string, Map<string, Field>>,
  file: string,
  problems: Problem[],
): void {
  const fields = schema.get(model);
  if (!fields) return;

  for (const entry of entriesOf(block)) {
    if (ARGUMENT_KEYS.has(entry.key)) continue;

    const field = fields.get(entry.key);
    if (!field) {
      problems.push({ file, model, field: entry.key });
      continue;
    }

    // Relación con más consulta dentro: se sigue al modelo relacionado.
    if (entry.block && field.relatedModel) {
      const nested = entriesOf(entry.block);
      const projections = nested.filter((n) => n.key === "select" || n.key === "include");
      if (projections.length === 0) continue;
      for (const projection of projections) {
        if (projection.block) {
          checkProjection(projection.block, field.relatedModel, schema, file, problems);
        }
      }
    }
  }
}

// ── el test ───────────────────────────────────────────────────────────

const schema = parseSchema(readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8"));

const accessorToModel = new Map<string, string>();
for (const model of schema.keys()) accessorToModel.set(accessorFor(model), model);

const sources = walk(join(ROOT, "src")).map((path) => ({
  path: relative(ROOT, path).split("\\").join("/"),
  code: readFileSync(path, "utf8"),
}));

function findProblems(): Problem[] {
  const problems: Problem[] = [];

  for (const file of sources) {
    // `prisma.evento.findMany({`, `tx.event.create({`, `db.event.findFirst({`
    const pattern = /\b(?:prisma|tx|db|client)\.(\w+)\.(findMany|findUnique|findFirst|create|update|updateMany|upsert|delete|deleteMany|count|groupBy|aggregate)\s*\(/g;

    for (const match of file.code.matchAll(pattern)) {
      const model = accessorToModel.get(match[1] as string);
      if (!model) continue;

      const argStart = file.code.indexOf("{", (match.index ?? 0) + match[0].length - 1);
      if (argStart === -1) continue;
      const args = balanced(file.code, argStart);
      if (!args) continue;

      for (const entry of entriesOf(args)) {
        if ((entry.key === "select" || entry.key === "include") && entry.block) {
          checkProjection(entry.block, model, schema, file.path, problems);
        }
      }
    }
  }

  return problems;
}

describe("el esquema se lee bien", () => {
  it("encuentra los modelos y sus campos", () => {
    expect(schema.size).toBeGreaterThan(20);
    expect(schema.get("Event")?.has("name")).toBe(true);
    expect(schema.get("Event")?.has("title")).toBe(false);
    expect(schema.get("Message")?.has("content")).toBe(true);
    expect(schema.get("Message")?.has("body")).toBe(false);
  });

  it("distingue relaciones de escalares", () => {
    expect(schema.get("Event")?.get("club")?.relatedModel).toBe("Club");
    expect(schema.get("Event")?.get("name")?.relatedModel).toBe(null);
  });

  it("el accesor del cliente respeta el de Prisma", () => {
    expect(accessorFor("Event")).toBe("event");
    expect(accessorFor("VIPOption")).toBe("vIPOption");
    expect(accessorFor("BrandSettings")).toBe("brandSettings");
  });
});

describe("el detector detecta", () => {
  it("caza un campo inventado en un select anidado", () => {
    // El fallo real que motivó este test, reproducido a mano.
    const problems: Problem[] = [];
    checkProjection(
      "{ event: { select: { id: true, title: true, startsAt: true } } }",
      "VIPOption",
      schema,
      "prueba.ts",
      problems,
    );
    expect(problems).toEqual([{ file: "prueba.ts", model: "Event", field: "title" }]);
  });

  it("no se queja de un select correcto", () => {
    const problems: Problem[] = [];
    checkProjection(
      "{ event: { select: { id: true, name: true, startsAt: true } } }",
      "VIPOption",
      schema,
      "prueba.ts",
      problems,
    );
    expect(problems).toEqual([]);
  });

  it("no confunde argumentos de consulta con campos", () => {
    const problems: Problem[] = [];
    checkProjection(
      "{ prices: { where: { isCurrent: true }, take: 1, select: { amountCents: true } } }",
      "TicketType",
      schema,
      "prueba.ts",
      problems,
    );
    expect(problems).toEqual([]);
  });
});

describe("todas las consultas del código", () => {
  it("solo piden campos que existen en el esquema", () => {
    const problems = findProblems();
    const readable = problems.map((p) => `${p.file}: ${p.model}.${p.field}`);
    expect(readable).toEqual([]);
  });
});
