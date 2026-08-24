import { t, type Locale } from "@nightlife/core/i18n";

/**
 * Botones de Google y Apple.
 *
 * Son enlaces, no botones con JavaScript: el flujo empieza con una navegación
 * de servidor a `/auth/start/{proveedor}`, que es donde se genera el PKCE. Así
 * el navegador no necesita ni una línea de JS para esto, y funciona igual con
 * el JavaScript a medio cargar — que en el móvil de alguien con mala cobertura
 * es la mitad de las veces.
 *
 * **Si el proveedor no está configurado no se pinta un botón que no lleva a
 * ningún sitio.** Se pinta desactivado y con el motivo. Un botón que parece
 * funcionar y no funciona es peor que no tenerlo.
 *
 * Marca de Apple: fondo negro, logotipo oficial en blanco, texto «Continuar con
 * Apple». Son las reglas de Apple para «Sign in with Apple» y no son opcionales
 * si algún día esto pasa por App Store. El logo es el glifo oficial dibujado a
 * mano en SVG, sin librerías y sin deformarlo.
 */

function GoogleMark() {
  // Los cuatro colores oficiales de Google. Es una de las poquísimas
  // excepciones a la regla de «sin colores literales»: la marca de otro no se
  // pinta con nuestros tokens.
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg width="17" height="20" viewBox="0 0 17 20" fill="currentColor" aria-hidden="true">
      <path d="M14.09 10.62c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.14.84-1.23 1.18-2.42 1.2-2.48-.03-.01-2.29-.88-2.31-3.5zM11.9 3.9c.6-.74 1.02-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.06 1.69-.93 2.69.97.07 1.97-.49 2.59-1.22z" />
    </svg>
  );
}

export function AuthProviders({
  locale,
  configured,
  next,
}: {
  locale: Locale;
  /** Sin credenciales en Supabase, los botones se enseñan desactivados. */
  configured: boolean;
  next?: string;
}) {
  const suffix = next ? `?next=${encodeURIComponent(next)}` : "";

  if (!configured) {
    return (
      <div className="grid gap-2">
        <span className="nl-provider nl-provider--off" aria-disabled="true">
          <GoogleMark />
          {t("continueGoogle", locale)}
        </span>
        <span className="nl-provider nl-provider--apple nl-provider--off" aria-disabled="true">
          <AppleMark />
          {t("continueApple", locale)}
        </span>
        <p className="nl-hint text-center">{t("providerNotConfigured", locale)}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <a href={`/auth/start/google${suffix}`} className="nl-provider">
        <GoogleMark />
        {t("continueGoogle", locale)}
      </a>
      <a href={`/auth/start/apple${suffix}`} className="nl-provider nl-provider--apple">
        <AppleMark />
        {t("continueApple", locale)}
      </a>
    </div>
  );
}

/** La rayita con «o» en medio. */
export function AuthDivider({ locale }: { locale: Locale }) {
  return (
    <div className="nl-divider" role="separator">
      <span>{t("or", locale)}</span>
    </div>
  );
}
