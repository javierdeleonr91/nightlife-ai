import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@nightlife/auth";

/**
 * Puerta del dashboard.
 *
 * Solo comprueba que la sesión esté firmada y viva. Los permisos reales
 * (tenant y RBAC) se verifican en cada handler contra la base de datos: el
 * middleware no debe ser la única defensa, porque no conoce el club al que se
 * intenta acceder ni el rol de la persona en él.
 */
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.AUTH_SECRET;

  if (!token || !secret || !(await verifySessionToken(token, secret))) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/club/:path*", "/promoter/:path*", "/admin/:path*"],
};
