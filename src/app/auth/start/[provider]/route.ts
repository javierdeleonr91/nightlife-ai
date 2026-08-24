import { NextResponse } from "next/server";
import { authorizeUrl, createPkcePair, isOAuthProvider } from "@nightlife/core/oauth";
import { PKCE_COOKIE, oauthConfigured, supabaseAuthConfig } from "@/lib/oauth";

/**
 * Empieza el acceso con Google o Apple.
 *
 * Genera el par PKCE, guarda el verificador en una cookie httpOnly y manda el
 * navegador a Supabase. El verificador no sale nunca del servidor: es lo que
 * hace que el código que vuelve en la URL no le sirva a nadie más.
 *
 * Si el proveedor no está configurado, esto redirige a /login con un aviso en
 * lugar de romperse. La interfaz ya lo enseña deshabilitado, pero alguien puede
 * llegar aquí con un enlace guardado.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = new URL(request.url).origin;

  if (!isOAuthProvider(provider) || !oauthConfigured()) {
    return NextResponse.redirect(new URL("/login?error=provider", origin));
  }

  const config = supabaseAuthConfig();
  const { verifier, challenge } = await createPkcePair();

  const target = authorizeUrl({
    supabaseUrl: config.supabaseUrl,
    provider,
    redirectTo: `${origin}/auth/callback`,
    challenge,
  });

  const response = NextResponse.redirect(target);
  response.cookies.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // Diez minutos: lo que tarda alguien en decidirse en la pantalla de Google.
    maxAge: 600,
  });
  return response;
}
