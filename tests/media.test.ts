import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MEDIA_BUCKET,
  buildMediaPath,
  extensionFor,
  isMediaSlotId,
  ownedPrefix,
  pathBelongsTo,
  publicUrlFor,
  storagePathFromPublicUrl,
  validateUpload,
} from "@nightlife/core/media";
import { promoterCompletion, clubCompletion } from "@nightlife/core/completion";

const SUPABASE = "https://abcdefgh.supabase.co";

describe("qué se puede subir", () => {
  it("acepta exactamente jpeg, png y webp", () => {
    expect([...ALLOWED_IMAGE_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(validateUpload({ contentType: type, bytes: 1000 })).toBe(null);
    }
  });

  it("rechaza lo que no es una imagen de las nuestras", () => {
    expect(validateUpload({ contentType: "image/gif", bytes: 1000 })).toBe("TYPE_NOT_ALLOWED");
    expect(validateUpload({ contentType: "image/svg+xml", bytes: 1000 })).toBe("TYPE_NOT_ALLOWED");
    expect(validateUpload({ contentType: "application/pdf", bytes: 1000 })).toBe("TYPE_NOT_ALLOWED");
    expect(validateUpload({ contentType: "text/html", bytes: 1000 })).toBe("TYPE_NOT_ALLOWED");
  });

  it("el tope son 5 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(validateUpload({ contentType: "image/jpeg", bytes: MAX_IMAGE_BYTES })).toBe(null);
    expect(validateUpload({ contentType: "image/jpeg", bytes: MAX_IMAGE_BYTES + 1 })).toBe("TOO_LARGE");
  });

  it("un archivo vacío no pasa", () => {
    expect(validateUpload({ contentType: "image/jpeg", bytes: 0 })).toBe("EMPTY");
    expect(validateUpload({ contentType: "image/jpeg", bytes: -1 })).toBe("EMPTY");
  });
});

describe("rutas dentro del bucket", () => {
  it("un solo bucket para todo el contenido visual de perfiles", () => {
    expect(MEDIA_BUCKET).toBe("profile-media");
  });

  it("cada tipo va a su carpeta, con el id del dueño dentro", () => {
    const cases: [Parameters<typeof buildMediaPath>[0]["slot"], string][] = [
      ["promoter-avatar", "promoters/p1/avatar/u1.jpg"],
      ["promoter-cover", "promoters/p1/cover/u1.jpg"],
      ["club-logo", "clubs/p1/logo/u1.jpg"],
      ["club-cover", "clubs/p1/cover/u1.jpg"],
    ];
    for (const [slot, expected] of cases) {
      expect(
        buildMediaPath({ slot, ownerId: "p1", contentType: "image/jpeg", unique: "u1" }),
      ).toBe(expected);
    }
  });

  it("la extensión sale del tipo, no del nombre del archivo", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/jpeg")).toBe("jpg");
  });

  it("nunca usa el nombre original: id de dueño y nombre se saneen", () => {
    const path = buildMediaPath({
      slot: "promoter-avatar",
      ownerId: "../../etc",
      contentType: "image/png",
      unique: "a/b c.php",
    });
    // El punto de «.php» también desaparece: la única extensión de la ruta
    // final es la que decide el tipo MIME, nunca la que traía el archivo.
    expect(path).toBe("promoters/etc/avatar/abcphp.png");
    expect(path.includes("..")).toBe(false);
    expect(path.endsWith(".png")).toBe(true);
  });

  it("una ruta imposible de sanear falla en vez de escribir donde sea", () => {
    expect(() =>
      buildMediaPath({ slot: "promoter-avatar", ownerId: "///", contentType: "image/png", unique: "x" }),
    ).toThrow();
  });

  it("dos subidas del mismo dueño no comparten nombre", () => {
    const a = buildMediaPath({ slot: "promoter-avatar", ownerId: "p1", contentType: "image/jpeg", unique: "one" });
    const b = buildMediaPath({ slot: "promoter-avatar", ownerId: "p1", contentType: "image/jpeg", unique: "two" });
    expect(a).not.toBe(b);
  });

  it("reconoce los ids de slot válidos y solo esos", () => {
    expect(isMediaSlotId("promoter-avatar")).toBe(true);
    expect(isMediaSlotId("club-logo")).toBe(true);
    expect(isMediaSlotId("promoter-secret")).toBe(false);
    expect(isMediaSlotId("toString")).toBe(false);
  });
});

describe("nadie escribe en la carpeta de otro", () => {
  it("la ruta tiene que empezar por el prefijo de su dueño", () => {
    expect(ownedPrefix({ slot: "promoter-avatar", ownerId: "p1" })).toBe("promoters/p1/avatar/");
    expect(pathBelongsTo({ path: "promoters/p1/avatar/x.jpg", slot: "promoter-avatar", ownerId: "p1" })).toBe(true);
  });

  it("la ruta de otro promoter se rechaza", () => {
    expect(pathBelongsTo({ path: "promoters/p2/avatar/x.jpg", slot: "promoter-avatar", ownerId: "p1" })).toBe(false);
  });

  it("la carpeta equivocada del mismo dueño también", () => {
    expect(pathBelongsTo({ path: "promoters/p1/cover/x.jpg", slot: "promoter-avatar", ownerId: "p1" })).toBe(false);
    expect(pathBelongsTo({ path: "clubs/p1/logo/x.jpg", slot: "promoter-avatar", ownerId: "p1" })).toBe(false);
  });
});

describe("borrar solo lo nuestro", () => {
  const url = `${SUPABASE}/storage/v1/object/public/profile-media/promoters/p1/avatar/x.jpg`;

  it("la URL pública se compone del bucket y la ruta", () => {
    expect(publicUrlFor({ supabaseUrl: SUPABASE, path: "promoters/p1/avatar/x.jpg" })).toBe(url);
  });

  it("de una URL nuestra se saca la ruta", () => {
    expect(storagePathFromPublicUrl({ url, supabaseUrl: SUPABASE })).toBe("promoters/p1/avatar/x.jpg");
  });

  it("una URL de fuera devuelve null: no se intenta borrar", () => {
    expect(
      storagePathFromPublicUrl({ url: "https://cdn.otro.com/foto.jpg", supabaseUrl: SUPABASE }),
    ).toBe(null);
    expect(
      storagePathFromPublicUrl({
        url: `${SUPABASE}/storage/v1/object/public/otro-bucket/x.jpg`,
        supabaseUrl: SUPABASE,
      }),
    ).toBe(null);
  });

  it("una ruta con .. no se acepta ni viniendo de nuestra base de datos", () => {
    expect(
      storagePathFromPublicUrl({
        url: `${SUPABASE}/storage/v1/object/public/profile-media/../../secret`,
        supabaseUrl: SUPABASE,
      }),
    ).toBe(null);
  });

  it("sin URL, nada que borrar", () => {
    expect(storagePathFromPublicUrl({ url: null, supabaseUrl: SUPABASE })).toBe(null);
    expect(storagePathFromPublicUrl({ url: "", supabaseUrl: SUPABASE })).toBe(null);
  });
});

describe("la service role key no sale del servidor", () => {
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

  const files = walk(join(ROOT, "src")).map((path) => ({
    path: relative(ROOT, path).split("\\").join("/"),
    code: readFileSync(path, "utf8"),
  }));

  it("solo lib/storage.ts la lee", () => {
    const offenders = files
      .filter((f) => f.path !== "src/lib/storage.ts")
      .filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("lib/storage.ts está marcado como server-only", () => {
    const storage = files.find((f) => f.path === "src/lib/storage.ts");
    expect(storage?.code.startsWith('import "server-only"')).toBe(true);
  });

  it("ningún componente de cliente importa el módulo de storage", () => {
    const offenders = files
      .filter((f) => f.code.startsWith('"use client"') || f.code.startsWith("'use client'"))
      .filter((f) => /from "@\/lib\/storage"/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no hay ninguna variable de Supabase con prefijo público", () => {
    const offenders = files
      .filter((f) => /NEXT_PUBLIC_SUPABASE_SERVICE|NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("porcentaje de perfil completo", () => {
  const empty = {
    photoUrl: null,
    coverImageUrl: null,
    bio: null,
    city: null,
    instagram: null,
    fourvenuesUrl: null,
    approvedClubCount: 0,
    selectedEventCount: 0,
  };

  it("un perfil vacío está al 0% y no se marca completo", () => {
    const report = promoterCompletion(empty);
    expect(report.percent).toBe(0);
    expect(report.complete).toBe(false);
  });

  it("sale de los datos reales, no de un contador de onboarding", () => {
    const withPhoto = promoterCompletion({ ...empty, photoUrl: "https://x/y.jpg" });
    expect(withPhoto.percent).toBeGreaterThan(0);
    expect(withPhoto.pending.some((t) => t.id === "photo")).toBe(false);
  });

  it("un campo con espacios no cuenta como relleno", () => {
    expect(promoterCompletion({ ...empty, bio: "   " }).percent).toBe(0);
  });

  it("todo puesto es 100% y la tarjeta desaparece", () => {
    const report = promoterCompletion({
      photoUrl: "https://x/a.jpg",
      coverImageUrl: "https://x/b.jpg",
      bio: "Llevo la noche de Madrid",
      city: "Madrid",
      instagram: "@alex",
      fourvenuesUrl: "https://www.fourvenues.com/x",
      approvedClubCount: 1,
      selectedEventCount: 3,
    });
    expect(report.percent).toBe(100);
    expect(report.complete).toBe(true);
    expect(report.pending).toEqual([]);
  });

  it("quitar un dato baja el porcentaje: no es un logro permanente", () => {
    const full = promoterCompletion({ ...empty, photoUrl: "https://x/a.jpg", bio: "hola" });
    const less = promoterCompletion({ ...empty, photoUrl: "https://x/a.jpg" });
    expect(less.percent).toBeLessThan(full.percent);
  });

  it("el club tiene su propia lista y Fourvenues pesa lo que más", () => {
    const report = clubCompletion({
      logoUrl: null,
      coverImageUrl: null,
      description: null,
      address: null,
      instagram: null,
      fourvenuesConnected: false,
      eventCount: 0,
      promoterCount: 0,
    });
    expect(report.pending.some((t) => t.id === "fourvenues")).toBe(true);
    const fourvenues = report.tasks.find((t) => t.id === "fourvenues");
    const other = report.tasks.find((t) => t.id === "instagram");
    expect(fourvenues!.weight).toBeGreaterThan(other!.weight);
  });
});
