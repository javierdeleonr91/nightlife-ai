import { LOCALES, type Locale } from "@nightlife/core/i18n";

/**
 * ES / EN.
 *
 * Enlaces, no un desplegable con estado: son dos opciones y se ven las dos.
 * Al ser navegación de servidor funciona antes de que cargue el JavaScript,
 * que es exactamente cuando alguien se da cuenta de que la página está en un
 * idioma que no entiende.
 */
export function LanguageSwitch({ current, next }: { current: Locale; next: string }) {
  return (
    <div className="nl-lang" role="group" aria-label="Language">
      {LOCALES.map((locale) => (
        <a
          key={locale}
          href={`/api/v1/auth/locale?set=${locale}&next=${encodeURIComponent(next)}`}
          className="nl-lang__option"
          aria-current={locale === current}
          hrefLang={locale}
        >
          {locale}
        </a>
      ))}
    </div>
  );
}
