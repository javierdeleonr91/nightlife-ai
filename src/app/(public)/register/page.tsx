import { cookies, headers } from "next/headers";
import Link from "next/link";
import { LOCALE_COOKIE, resolveLocale, t } from "@nightlife/core/i18n";
import { oauthConfigured } from "@/lib/oauth";
import { AuthDivider, AuthProviders } from "@/components/auth-providers";
import { LanguageSwitch } from "@/components/language-switch";
import { PasswordForm } from "@/components/password-form";

/**
 * Crear cuenta.
 *
 * Misma estructura que entrar, a propósito: quien se equivoca de pantalla no
 * tiene que reorientarse. Y con proveedor no se pide nada más que un toque —
 * el tipo de cuenta se elige después, en /onboarding, porque Google no sabe si
 * llevas un club o haces RRPP y nosotros tampoco vamos a adivinarlo.
 */

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  return (
    <div className="nl-app grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <header className="nl-enter mb-7 flex items-start justify-between gap-4">
          <div>
            <p className="nl-eyebrow">Nightlife Automatico</p>
            <h1 className="nl-display nl-h1 mt-2">{t("registerTitle", locale)}</h1>
          </div>
          <LanguageSwitch current={locale} next="/register" />
        </header>

        <div className="nl-enter grid gap-5">
          <AuthProviders locale={locale} configured={oauthConfigured()} />
          <AuthDivider locale={locale} />
          <PasswordForm mode="register" locale={locale} next="/onboarding" />
        </div>

        <p className="nl-muted mt-6 text-[0.9375rem]">
          {t("hasAccount", locale)}{" "}
          <Link href="/login" className="underline underline-offset-4" style={{ color: "var(--nl-hot-ink)" }}>
            {t("signIn", locale)}
          </Link>
        </p>
      </div>
    </div>
  );
}
