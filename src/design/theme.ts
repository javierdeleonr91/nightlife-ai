/**
 * Los pocos valores del design system que un archivo CSS no puede servir.
 *
 * `themeColor` en la metadata de Next, el color del manifest y cualquier sitio
 * donde haga falta un string y no una custom property. Se centralizan aquí
 * para que sigan siendo una sola fuente de verdad: si cambia --nl-base en
 * tokens.css, cambia también esta constante, y el test de design system
 * vigila que no aparezcan literales sueltos en ningún otro sitio.
 */

/** Debe coincidir con --nl-base de tokens.css. */
export const THEME_BACKGROUND = "#0B0A10";

/** Debe coincidir con --nl-hot de tokens.css. */
export const THEME_ACCENT = "#FF2D6F";

/** Debe coincidir con --nl-text de tokens.css. */
export const THEME_TEXT = "#F5F2F8";
