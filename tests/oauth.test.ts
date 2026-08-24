import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeUrl,
  createPkcePair,
  decideLink,
  destinationFor,
  needsName,
  isOAuthProvider,
  linkRefusalMessage,
  signInMethodLabel,
  signInMethodsFor,
  tokenExchangeUrl,
  type ProviderProfile,
} from "@nightlife/core/oauth";
import { AUTH_COPY, LOCALES, resolveLocale, isLocale, t } from "@nightlife/core/i18n";

const SUPABASE = "https://abcdefgh.supabase.co";

const google: ProviderProfile = {
  provider: "google",
  subject: "google-sub-123",
  email: "javier@example.com",
  emailVerified: true,
  name: "Javier De Leon",
};

describe("proveedores", () => {
  it("solo google y apple", () => {
    expect(isOAuthProvider("google")).toBe(true);
    expect(isOAuthProvider("apple")).toBe(true);
    expect(isOAuthProvider("facebook")).toBe(false);
    expect(isOAuthProvider("")).toBe(false);
  });

  it("el método se enseña con nombre, nunca con un token", () => {
    expect(signInMethodLabel("google", "es")).toBe("Google");
    expect(signInMethodLabel("password", "es")).toBe("Email y contraseña");
    expect(signInMethodLabel("password", "en")).toBe("Email and password");
  });

  it("un proveedor desconocido no rompe la pantalla", () => {
    expect(signInMethodLabel("github", "en")).toBe("Github");
  });
});

describe("con qué puede entrar cada persona", () => {
  /*
   * `UserIdentity` guarda solo identidades externas. La contraseña vive en
   * `User.passwordHash`. Los métodos se leen de las dos fuentes: si se
   * dedujeran de una sola, todas las cuentas que ya existen aparecerían sin
   * ningún método hasta hacerles un backfill.
   */

  it("solo contraseña", () => {
    expect(signInMethodsFor({ hasPassword: true, identityProviders: [] })).toEqual(["password"]);
  });

  it("solo Google", () => {
    expect(signInMethodsFor({ hasPassword: false, identityProviders: ["google"] })).toEqual([
      "google",
    ]);
  });

  it("los dos a la vez: se enseñan los dos", () => {
    expect(signInMethodsFor({ hasPassword: true, identityProviders: ["google"] })).toEqual([
      "password",
      "google",
    ]);
  });

  it("una cuenta antigua sin filas de identidad sigue teniendo su método", () => {
    // El motivo de no necesitar backfill: `passwordHash` ya lo dice todo.
    expect(signInMethodsFor({ hasPassword: true, identityProviders: [] })).toContain("password");
  });

  it("un proveedor que no conocemos no se cuela como método", () => {
    expect(signInMethodsFor({ hasPassword: false, identityProviders: ["github"] })).toEqual([]);
  });

  it("no se repite un proveedor duplicado", () => {
    expect(
      signInMethodsFor({ hasPassword: false, identityProviders: ["google", "google"] }),
    ).toEqual(["google"]);
  });
});

describe("PKCE", () => {
  it("el reto es el SHA-256 del verificador, no el verificador", async () => {
    const pair = await createPkcePair(new Uint8Array(64).fill(7));
    expect(pair.verifier.length).toBeGreaterThan(40);
    expect(pair.challenge).not.toBe(pair.verifier);
    // base64url: sin +, / ni =
    expect(/^[A-Za-z0-9_-]+$/.test(pair.challenge)).toBe(true);
  });

  it("el mismo azar da el mismo par", async () => {
    const a = await createPkcePair(new Uint8Array(64).fill(3));
    const b = await createPkcePair(new Uint8Array(64).fill(3));
    expect(a.verifier).toBe(b.verifier);
    expect(a.challenge).toBe(b.challenge);
  });

  it("azar distinto da verificadores distintos", async () => {
    const a = await createPkcePair(new Uint8Array(64).fill(1));
    const b = await createPkcePair(new Uint8Array(64).fill(2));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("URLs del flujo", () => {
  it("la de autorización lleva provider, redirect y el reto", async () => {
    const url = new URL(
      authorizeUrl({
        supabaseUrl: SUPABASE,
        provider: "google",
        redirectTo: "https://app.test/auth/callback",
        challenge: "RETO",
      }),
    );
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe("https://app.test/auth/callback");
    expect(url.searchParams.get("code_challenge")).toBe("RETO");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
  });

  it("el verificador NUNCA viaja en la URL de autorización", async () => {
    const pair = await createPkcePair(new Uint8Array(64).fill(5));
    const url = authorizeUrl({
      supabaseUrl: SUPABASE,
      provider: "apple",
      redirectTo: "https://app.test/auth/callback",
      challenge: pair.challenge,
    });
    // Si el verificador saliera aquí, PKCE no protegería de nada.
    expect(url.includes(pair.verifier)).toBe(false);
  });

  it("una barra de más en la URL de Supabase no duplica la ruta", () => {
    expect(tokenExchangeUrl(`${SUPABASE}/`)).toBe(`${SUPABASE}/auth/v1/token?grant_type=pkce`);
  });
});

describe("vincular cuentas sin duplicar ni regalar el acceso", () => {
  it("segunda vez con el mismo proveedor: entra", () => {
    const decision = decideLink({
      profile: google,
      byIdentity: { userId: "u1", hasPassword: false },
      byEmail: null,
    });
    expect(decision).toEqual({ kind: "SIGN_IN", userId: "u1" });
  });

  it("cambió el email en Google pero es la misma identidad: sigue siendo él", () => {
    const decision = decideLink({
      profile: { ...google, email: "otro@example.com" },
      byIdentity: { userId: "u1", hasPassword: false },
      byEmail: null,
    });
    expect(decision).toEqual({ kind: "SIGN_IN", userId: "u1" });
  });

  it("email nuevo: cuenta nueva", () => {
    expect(decideLink({ profile: google, byIdentity: null, byEmail: null })).toEqual({
      kind: "CREATE",
    });
  });

  it("ya tenía cuenta con contraseña y el email está verificado: se vincula", () => {
    // El caso del enunciado: primero email/password, después Google.
    const decision = decideLink({
      profile: google,
      byIdentity: null,
      byEmail: { userId: "u9", hasPassword: true },
    });
    expect(decision).toEqual({ kind: "LINK", userId: "u9" });
  });

  it("NUNCA crea una segunda cuenta con un email que ya existe", () => {
    for (const verified of [true, false]) {
      const decision = decideLink({
        profile: { ...google, emailVerified: verified },
        byIdentity: null,
        byEmail: { userId: "u9", hasPassword: true },
      });
      expect(decision.kind).not.toBe("CREATE");
    }
  });

  it("email sin verificar sobre una cuenta existente: se rechaza", () => {
    // Sin esto, registrar ese email en un proveedor cualquiera daría acceso a
    // la cuenta de otra persona.
    const decision = decideLink({
      profile: { ...google, emailVerified: false },
      byIdentity: null,
      byEmail: { userId: "u9", hasPassword: true },
    });
    expect(decision).toEqual({ kind: "REFUSE", reason: "UNVERIFIED_EMAIL" });
  });

  it("sin email no se decide nada", () => {
    const decision = decideLink({
      profile: { ...google, email: null },
      byIdentity: null,
      byEmail: null,
    });
    expect(decision).toEqual({ kind: "REFUSE", reason: "NO_EMAIL" });
  });

  it("la identidad permanente NUNCA es el email", () => {
    // Dos personas distintas del mismo proveedor con el mismo email no pueden
    // existir, pero la misma persona SÍ puede cambiar de email. Si la clave
    // fuera el email, ese cambio la convertiría en otra cuenta.
    const cambio = decideLink({
      profile: { ...google, email: "nuevo@example.com" },
      byIdentity: { userId: "u1", hasPassword: false },
      byEmail: null,
    });
    expect(cambio).toEqual({ kind: "SIGN_IN", userId: "u1" });

    // Y al revés: mismo email, subject distinto → no entra en la cuenta ajena
    // sin la comprobación de email verificado.
    const otroSubject = decideLink({
      profile: { ...google, subject: "otro-sub", emailVerified: false },
      byIdentity: null,
      byEmail: { userId: "u1", hasPassword: true },
    });
    expect(otroSubject.kind).toBe("REFUSE");
  });

  it("mismo Apple, mismo usuario", () => {
    const apple: ProviderProfile = {
      provider: "apple",
      subject: "001234.abcdef.0987",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
      // Apple solo manda el nombre la primera vez. Aquí no viene.
      name: null,
    };
    expect(
      decideLink({ profile: apple, byIdentity: { userId: "u7", hasPassword: false }, byEmail: null }),
    ).toEqual({ kind: "SIGN_IN", userId: "u7" });
  });

  it("los motivos de rechazo se explican en los dos idiomas y sin jerga", () => {
    for (const reason of ["NO_EMAIL", "UNVERIFIED_EMAIL"] as const) {
      for (const locale of LOCALES) {
        const message = linkRefusalMessage(reason, locale);
        expect(message.length).toBeGreaterThan(20);
        expect(/oauth|token|provider_id|null/i.test(message)).toBe(false);
      }
    }
  });
});

describe("a dónde va cada uno después de entrar", () => {
  it("promoter con perfil, a su panel", () => {
    expect(
      destinationFor({ accountType: "PROMOTER", promoterSlug: "javier", clubSlug: null }),
    ).toBe("/promoter/home");
  });

  it("club con perfil, al suyo", () => {
    expect(destinationFor({ accountType: "CLUB", promoterSlug: null, clubSlug: "mon" })).toBe(
      "/club/mon/overview",
    );
  });

  it("primera vez: al selector, nunca adivinando el tipo", () => {
    expect(destinationFor({ accountType: null, promoterSlug: null, clubSlug: null })).toBe(
      "/onboarding",
    );
  });

  it("tipo elegido pero perfil sin crear: también al selector", () => {
    // A medio onboarding. Mandarle al panel enseñaría una pantalla vacía.
    expect(destinationFor({ accountType: "PROMOTER", promoterSlug: null, clubSlug: null })).toBe(
      "/onboarding",
    );
  });
});

describe("Apple y el nombre que no siempre manda", () => {
  /*
   * El fallo que estos tests fijan: encadenar «Apple no mandó nombre» con
   * «vete a onboarding» devolvía a un promoter con su perfil terminado al
   * onboarding EN CADA LOGIN, porque Apple solo entrega el nombre en la primera
   * autorización. El destino lo deciden nuestros datos, no los suyos.
   */

  const appleNuevo: ProviderProfile = {
    provider: "apple",
    subject: "001234.abcdef.0987",
    email: "relay@privaterelay.appleid.com",
    emailVerified: true,
    name: null,
  };

  it("Apple nuevo sin nombre → onboarding", () => {
    expect(decideLink({ profile: appleNuevo, byIdentity: null, byEmail: null })).toEqual({
      kind: "CREATE",
    });
    expect(destinationFor({ accountType: null, promoterSlug: null, clubSlug: null })).toBe(
      "/onboarding",
    );
  });

  it("Apple conocido + promoter completo + sin nombre en el OAuth → panel de promoter", () => {
    expect(
      decideLink({
        profile: appleNuevo,
        byIdentity: { userId: "u1", hasPassword: false },
        byEmail: null,
      }),
    ).toEqual({ kind: "SIGN_IN", userId: "u1" });

    expect(
      destinationFor({ accountType: "PROMOTER", promoterSlug: "javier", clubSlug: null }),
    ).toBe("/promoter/home");
  });

  it("Apple conocido + club completo + sin nombre en el OAuth → panel del club", () => {
    expect(destinationFor({ accountType: "CLUB", promoterSlug: null, clubSlug: "mon" })).toBe(
      "/club/mon/overview",
    );
  });

  it("Google conocido con perfil completo → su panel", () => {
    expect(
      decideLink({ profile: google, byIdentity: { userId: "u2", hasPassword: true }, byEmail: null }),
    ).toEqual({ kind: "SIGN_IN", userId: "u2" });
    expect(
      destinationFor({ accountType: "PROMOTER", promoterSlug: "javier", clubSlug: null }),
    ).toBe("/promoter/home");
  });

  it("una identidad conocida NUNCA crea otro usuario", () => {
    // Con o sin email, con o sin verificar, con o sin cuenta con ese email:
    // si conocemos (provider, subject), se entra a ese usuario y ya está.
    const variantes: ProviderProfile[] = [
      appleNuevo,
      { ...appleNuevo, email: null },
      { ...appleNuevo, emailVerified: false },
      { ...google, email: "cambiado@example.com" },
    ];
    for (const profile of variantes) {
      const decision = decideLink({
        profile,
        byIdentity: { userId: "u1", hasPassword: false },
        byEmail: { userId: "otro", hasPassword: true },
      });
      expect(decision).toEqual({ kind: "SIGN_IN", userId: "u1" });
    }
  });

  it("el destino no depende del nombre en absoluto", () => {
    // `destinationFor` ya no acepta el nombre. Este test lo fija: si alguien
    // vuelve a colarlo, deja de compilar o deja de pasar.
    const conPerfil = destinationFor({
      accountType: "PROMOTER",
      promoterSlug: "javier",
      clubSlug: null,
    });
    expect(conPerfil).toBe("/promoter/home");
  });

  it("el nombre se pide en onboarding, y solo si nos falta a NOSOTROS", () => {
    expect(needsName({ name: "" })).toBe(true);
    expect(needsName({ name: "   " })).toBe(true);
    expect(needsName({ name: null })).toBe(true);
    expect(needsName({ name: "Javier De Leon" })).toBe(false);
  });
});

describe("Hide My Email de Apple", () => {
  it("un relay distinto NO se adivina como la misma persona", () => {
    /*
     * Alguien con cuenta de contraseña en javier@example.com entra con Apple y
     * «Hide My Email». Nos llega otra dirección. Son dos cuentas distintas y
     * así se queda: deducir que son la misma sería vincular por parecido, que
     * es justo el agujero que cierra la regla del email verificado.
     */
    const relay: ProviderProfile = {
      provider: "apple",
      subject: "001.relay.999",
      email: "xyz123@privaterelay.appleid.com",
      emailVerified: true,
      name: null,
    };

    // No hay cuenta con ESE email, así que se crea una nueva. Correcto.
    expect(decideLink({ profile: relay, byIdentity: null, byEmail: null })).toEqual({
      kind: "CREATE",
    });
  });
});

describe("idiomas", () => {
  it("respeta lo que la persona eligió por encima del navegador", () => {
    expect(resolveLocale({ cookie: "en", acceptLanguage: "es-ES,es;q=0.9" })).toBe("en");
  });

  it("sin elección, usa el navegador", () => {
    expect(resolveLocale({ acceptLanguage: "en-GB,en;q=0.9,es;q=0.8" })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "es-ES,es;q=0.9" })).toBe("es");
  });

  it("un idioma que no tenemos cae en español", () => {
    expect(resolveLocale({ acceptLanguage: "de-DE,de;q=0.9" })).toBe("es");
    expect(resolveLocale({})).toBe("es");
    expect(resolveLocale({ cookie: "fr" })).toBe("es");
  });

  it("isLocale no acepta cualquier cosa", () => {
    expect(isLocale("es")).toBe(true);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("no falta ninguna traducción", () => {
    for (const [key, value] of Object.entries(AUTH_COPY)) {
      for (const locale of LOCALES) {
        const text = value[locale];
        expect(typeof text).toBe("string");
        if (key !== "or") expect(text.length).toBeGreaterThan(1);
      }
    }
  });

  it("los textos que pidió el producto son exactamente los acordados", () => {
    expect(t("continueGoogle", "es")).toBe("Continuar con Google");
    expect(t("continueApple", "es")).toBe("Continuar con Apple");
    expect(t("signIn", "es")).toBe("Iniciar sesión");
    expect(t("createAccount", "es")).toBe("Crear cuenta");
    expect(t("forgotPassword", "es")).toBe("¿Has olvidado la contraseña?");
    expect(t("continueGoogle", "en")).toBe("Continue with Google");
    expect(t("continueApple", "en")).toBe("Continue with Apple");
    expect(t("signIn", "en")).toBe("Sign in");
    expect(t("createAccount", "en")).toBe("Create account");
    expect(t("forgotPassword", "en")).toBe("Forgot password?");
  });
});

describe("los secretos no salen del servidor", () => {
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

  it("solo lib/oauth.ts lee la configuración de Supabase Auth", () => {
    const offenders = files
      .filter((f) => f.path !== "src/lib/oauth.ts")
      .filter((f) => /SUPABASE_ANON_KEY/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("lib/oauth.ts está marcado como server-only", () => {
    const module = files.find((f) => f.path === "src/lib/oauth.ts");
    expect(module?.code.startsWith('import "server-only"')).toBe(true);
  });

  it("ninguna variable de OAuth lleva prefijo público", () => {
    const offenders = files
      .filter((f) => /NEXT_PUBLIC_[A-Z_]*(SUPABASE|GOOGLE|APPLE|OAUTH|CLIENT_SECRET)/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no se guardan tokens de proveedor en la base de datos", () => {
    // OAuth aquí es autenticación, no acceso a Gmail ni a iCloud. El esquema no
    // debe tener dónde guardar un token aunque alguien quisiera.
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const identityModel = /model UserIdentity \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(identityModel.length).toBeGreaterThan(0);
    expect(/accessToken|refreshToken|idToken/i.test(identityModel)).toBe(false);
  });

  it("ningún componente de cliente importa la configuración de OAuth", () => {
    const offenders = files
      .filter((f) => f.code.startsWith('"use client"'))
      .filter((f) => /from "@\/lib\/oauth"/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("la rotación del secreto de Apple está documentada y no automatizada", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  it("existe el procedimiento escrito", () => {
    const doc = readFileSync(join(ROOT, "docs", "apple-secret-rotation.md"), "utf8");
    expect(doc).toContain("6 meses");
    expect(doc.toLowerCase()).toContain(".p8");
  });

  it("en ningún sitio se afirma que Supabase lo rote solo", () => {
    // Se afirmó en una versión anterior de la documentación y era falso: la
    // documentación de Supabase pide ponerse un recordatorio en el calendario.
    const sources = [
      readFileSync(join(ROOT, "src/packages/core/oauth.ts"), "utf8"),
      readFileSync(join(ROOT, "docs", "apple-secret-rotation.md"), "utf8"),
    ];
    for (const source of sources) {
      expect(/Supabase lo rota\b/.test(source)).toBe(false);
      expect(/rota autom[áa]tic/i.test(source)).toBe(false);
    }
  });

  it("el .p8 no puede entrar en el repositorio", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toContain("*.p8");
  });
});
