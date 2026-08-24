import { cookies, headers } from "next/headers";
import Link from "next/link";
import { LOCALE_COOKIE, resolveLocale, t } from "@nightlife/core/i18n";
import { oauthConfigured } from "@/lib/oauth";
import { AuthDivider, AuthProviders } from "@/components/auth-providers";
import { LanguageSwitch } from "@/components/language-switch";
import { PasswordForm } from "@/components/password-form";

/**
 * Entrar.
 *
 * La página es de servidor: el idioma y si hay proveedores configurados se
 * resuelven antes de mandar nada al navegador, así que no hay parpadeo de un
 * idioma a otro ni botones que aparecen medio segundo después.
 *
 * Los proveedores van arriba porque son el camino de un toque. El formulario de
 * email sigue existiendo debajo, no escondido tras un «otras opciones»: hay
 * gente que no quiere usar su cuenta de Google para esto y es una preferencia
 * legítima.
 */

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  // Los errores del flujo OAuth llegan por la URL como un código corto. Aquí se
  // traducen a algo que se entiende; el detalle se quedó en el log del servidor.
  const ERRORS: Record<string, string> = {
    provider: t("providerNotConfigured", locale),
    oauth: t("oauthFailed", locale),
    expired: t("oauthFailed", locale),
    cancelled: "",
    noemail:
      locale === "es"
        ? "Ese proveedor no nos ha dado tu email. Entra con email y contraseña."
        : "That provider didn't share your email. Sign in with email and password instead.",
    linkfirst:
      locale === "es"
        ? "Ya existe una cuenta con ese email. Entra con tu contraseña."
        : "An account with that email already exists. Sign in with your password.",
  };
  const error = params.error ? (ERRORS[params.error] ?? t("genericError", locale)) : null;

  return (
    <div className="nl-app grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <header className="nl-enter mb-7 flex items-start justify-between gap-4">
          <div>
            <p className="nl-eyebrow">Nightlife Automatico</p>
            <h1 className="nl-display nl-h1 mt-2">{t("signInTitle", locale)}</h1>
            <p className="nl-muted mt-2 text-[0.9375rem]">{t("signInSubtitle", locale)}</p>
          </div>
          <LanguageSwitch current={locale} next="/login" />
        </header>

        <div className="nl-enter grid gap-5">
          <AuthProviders locale={locale} configured={oauthConfigured()} next={params.next} />
          <AuthDivider locale={locale} />
          <PasswordForm mode="signin" locale={locale} error={error} next={params.next ?? null} />
        </div>

        <div className="mt-6 grid gap-2 text-[0.9375rem]">
          <p className="nl-muted">
            {t("noAccount", locale)}{" "}
            <Link
              href="/register"
              className="underline underline-offset-4"
              style={{ color: "var(--nl-hot-ink)" }}
            >
              {t("createAccount", locale)}
            </Link>
          </p>
          <Link href="/forgot-password" className="nl-dim underline underline-offset-4">
            {t("forgotPassword", locale)}
          </Link>
        </div>
      </div>
    </div>
  );
}
