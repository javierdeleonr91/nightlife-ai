import { cookies, headers } from "next/headers";
import Link from "next/link";
import { LOCALE_COOKIE, resolveLocale, t } from "@nightlife/core/i18n";
import { LanguageSwitch } from "@/components/language-switch";

/**
 * Recuperar contraseña.
 *
 * Existe porque el enlace de login apunta aquí y una pantalla que da 404 es
 * peor que no tener el enlace. Lo que **no** hace es fingir: enviar el correo
 * de recuperación necesita un proveedor de email configurado, y no lo hay.
 *
 * Un formulario que dice «te hemos enviado un email» sin enviarlo es la peor
 * versión posible de esta pantalla: la persona espera, no llega nada, y deja
 * de fiarse del producto entero.
 */

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  const copy =
    locale === "es"
      ? {
          body: "Todavía no podemos enviarte un correo de recuperación: nos falta configurar el envío de emails. Mientras tanto, si entraste con Google o con Apple puedes seguir usando ese botón, y si no, escríbenos y te la reseteamos a mano.",
          back: "Volver a entrar",
        }
      : {
          body: "We can't send you a reset email yet — email delivery isn't configured. In the meantime, if you signed up with Google or Apple that button still works, and otherwise get in touch and we'll reset it by hand.",
          back: "Back to sign in",
        };

  return (
    <div className="nl-app grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <header className="nl-enter mb-6 flex items-start justify-between gap-4">
          <h1 className="nl-display nl-h2">{t("forgotPassword", locale)}</h1>
          <LanguageSwitch current={locale} next="/forgot-password" />
        </header>

        <div className="nl-card p-5">
          <p className="nl-muted text-[0.9375rem]">{copy.body}</p>
          <div className="mt-5">
            <Link href="/login" className="nl-btn nl-btn--quiet nl-btn--block">
              {copy.back}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
