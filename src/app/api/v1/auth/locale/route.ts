import { NextResponse } from "next/server";
import { LOCALE_COOKIE, isLocale } from "@nightlife/core/i18n";

/**
 * Cambiar de idioma.
 *
 * Una cookie de un año, sin sesión de por medio: el idioma se elige antes de
 * entrar, que es justo cuando más falta hace. Es una navegación normal con
 * `next`, así que funciona sin JavaScript.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const locale = url.searchParams.get("set");
  const next = url.searchParams.get("next") ?? "/login";

  // `next` solo puede ser una ruta interna: un `next=https://otro-sitio` sería
  // una redirección abierta y nos convertiría en el trampolín de un phishing.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/login";

  const response = NextResponse.redirect(new URL(safeNext, url.origin));
  if (isLocale(locale)) {
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }
  return response;
}
