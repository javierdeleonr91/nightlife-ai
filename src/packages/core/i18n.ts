/**
 * Español e inglés en las pantallas de acceso.
 *
 * Solo cubre login, registro y el selector de tipo de cuenta. No es un sistema
 * de traducción para toda la aplicación: el panel está en inglés y las páginas
 * públicas en español por decisión de producto, y montar i18n completo para eso
 * sería infraestructura sin uso.
 *
 * Un diccionario plano con las dos lenguas al lado permite ver de un vistazo si
 * falta una traducción, y el tipo obliga a que no falte ninguna.
 */

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "es";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "es" || value === "en";
}

/**
 * De dónde sale el idioma, en orden: lo que la persona eligió, lo que pide su
 * navegador, y por último español.
 */
export function resolveLocale(args: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(args.cookie)) return args.cookie;
  const header = args.acceptLanguage ?? "";
  // `en-GB,en;q=0.9,es;q=0.8` → la primera que reconozcamos.
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().slice(0, 2).toLowerCase();
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

export const LOCALE_COOKIE = "nl_locale";

type Dictionary = Record<Locale, string>;

export const AUTH_COPY = {
  continueGoogle: { es: "Continuar con Google", en: "Continue with Google" },
  continueApple: { es: "Continuar con Apple", en: "Continue with Apple" },
  or: { es: "o", en: "or" },
  email: { es: "Email", en: "Email" },
  password: { es: "Contraseña", en: "Password" },
  name: { es: "Nombre", en: "Name" },
  signIn: { es: "Iniciar sesión", en: "Sign in" },
  signingIn: { es: "Entrando…", en: "Signing in…" },
  createAccount: { es: "Crear cuenta", en: "Create account" },
  creatingAccount: { es: "Creando cuenta…", en: "Creating account…" },
  noAccount: { es: "¿No tienes cuenta?", en: "Don't have an account?" },
  hasAccount: { es: "¿Ya tienes cuenta?", en: "Already have an account?" },
  forgotPassword: { es: "¿Has olvidado la contraseña?", en: "Forgot password?" },
  signInTitle: { es: "Entra en tu cuenta", en: "Sign in to your account" },
  registerTitle: { es: "Crea tu cuenta", en: "Create your account" },
  signInSubtitle: {
    es: "Tu equipo vende. La IA responde.",
    en: "Your team sells. The assistant answers.",
  },
  language: { es: "Idioma", en: "Language" },

  // Selector de tipo de cuenta tras el primer acceso social.
  chooseTitle: { es: "¿Cómo vas a usar la plataforma?", en: "How will you use the platform?" },
  chooseSubtitle: {
    es: "Puedes cambiarlo más adelante hablando con nosotros.",
    en: "You can change this later by getting in touch.",
  },
  iAmPromoter: { es: "Soy RRPP", en: "I'm a promoter" },
  iAmPromoterNote: {
    es: "Tengo mi propio link y muevo gente a varios clubs.",
    en: "I have my own link and bring people to several clubs.",
  },
  iAmClub: { es: "Soy una discoteca", en: "I run a venue" },
  iAmClubNote: {
    es: "Organizo las noches y vendo mis entradas en Fourvenues.",
    en: "I run the nights and sell my tickets on Fourvenues.",
  },

  // Errores. Ninguno dice nada técnico.
  genericError: {
    es: "Algo ha fallado. Inténtalo otra vez.",
    en: "Something went wrong. Try again.",
  },
  badCredentials: {
    es: "Ese email o esa contraseña no son correctos.",
    en: "That email or password isn't right.",
  },
  providerNotConfigured: {
    es: "Este método de acceso todavía no está activado.",
    en: "This sign-in method isn't switched on yet.",
  },
  oauthFailed: {
    es: "No hemos podido completar el acceso. Inténtalo otra vez.",
    en: "We couldn't finish signing you in. Try again.",
  },
} as const satisfies Record<string, Dictionary>;

export type AuthCopyKey = keyof typeof AUTH_COPY;

export function t(key: AuthCopyKey, locale: Locale): string {
  return AUTH_COPY[key][locale];
}
