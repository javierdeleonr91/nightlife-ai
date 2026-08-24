import { NextResponse } from "next/server";
import {
  decideLink,
  destinationFor,
  isOAuthProvider,
  tokenExchangeUrl,
  type ProviderProfile,
} from "@nightlife/core/oauth";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { createSession } from "@/lib/session";
import { PKCE_COOKIE, supabaseAuthConfig } from "@/lib/oauth";

/**
 * Vuelta de Google o de Apple.
 *
 * Aquí es donde la identidad del proveedor se convierte en una sesión nuestra.
 * Cinco pasos y ninguno es opcional:
 *
 *   1. canjear el código por la identidad, usando el verificador PKCE;
 *   2. decidir si es alguien conocido, alguien a vincular o alguien nuevo;
 *   3. crear o recuperar el usuario;
 *   4. abrir NUESTRA sesión;
 *   5. mandarle a su panel, o al selector si es su primera vez.
 *
 * Nunca se queda a medias: cualquier fallo acaba en /login con un mensaje que
 * se entiende, no en una pantalla en blanco con un código de error.
 *
 * El token de Supabase muere aquí. No se guarda, no se refresca y no viaja al
 * navegador: su único trabajo era decirnos quién es esta persona.
 */

export const dynamic = "force-dynamic";

interface SupabaseUser {
  id?: string;
  email?: string;
  user_metadata?: { full_name?: string; name?: string; email_verified?: boolean };
  app_metadata?: { provider?: string };
  identities?: { provider?: string; id?: string; identity_data?: Record<string, unknown> }[];
}

function fail(origin: string, reason: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
  response.cookies.set(PKCE_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");

  // Supabase devuelve `error_description` cuando la persona cancela en la
  // pantalla de Google. No es un fallo nuestro y no se registra como tal.
  if (url.searchParams.get("error")) return fail(origin, "cancelled");
  if (!code) return fail(origin, "oauth");

  const verifier = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE}=`))
    ?.slice(PKCE_COOKIE.length + 1);

  // Sin verificador el código no vale: o la cookie caducó, o alguien está
  // reenviando un código ajeno. En los dos casos, fuera.
  if (!verifier) return fail(origin, "expired");

  let config;
  try {
    config = supabaseAuthConfig();
  } catch {
    return fail(origin, "provider");
  }

  // ── 1. canje ────────────────────────────────────────────────────────
  let payload: { user?: SupabaseUser } | null = null;
  try {
    const response = await fetch(tokenExchangeUrl(config.supabaseUrl), {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        authorization: `Bearer ${config.anonKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      cache: "no-store",
    });
    if (!response.ok) {
      // El cuerpo puede traer detalles del proyecto: no se propaga ni se loguea.
      console.error("[auth] canje OAuth rechazado", response.status);
      return fail(origin, "oauth");
    }
    payload = (await response.json()) as { user?: SupabaseUser };
  } catch {
    return fail(origin, "oauth");
  }

  const supabaseUser = payload?.user;
  const identity = supabaseUser?.identities?.[0];
  const providerName = identity?.provider ?? supabaseUser?.app_metadata?.provider ?? "";
  if (!supabaseUser?.id || !isOAuthProvider(providerName)) return fail(origin, "oauth");

  const profile: ProviderProfile = {
    provider: providerName,
    // El `sub` del proveedor. Es lo único estable: el email puede cambiar.
    subject: String(identity?.id ?? supabaseUser.id),
    email: supabaseUser.email?.toLowerCase() ?? null,
    // Google y Apple verifican siempre. Se comprueba igualmente en vez de
    // darlo por hecho: de ese booleano depende que se vincule o no una cuenta
    // que ya existe.
    emailVerified: supabaseUser.user_metadata?.email_verified !== false,
    name: supabaseUser.user_metadata?.full_name ?? supabaseUser.user_metadata?.name ?? null,
  };

  // ── 2 y 3. quién es ─────────────────────────────────────────────────
  let userId: string;
  try {
    const [byIdentity, byEmail] = await Promise.all([
      prisma.userIdentity.findUnique({
        where: { provider_subject: { provider: profile.provider, subject: profile.subject } },
        select: { userId: true, user: { select: { passwordHash: true } } },
      }),
      profile.email
        ? prisma.user.findUnique({
            where: { email: profile.email },
            select: { id: true, passwordHash: true },
          })
        : null,
    ]);

    const decision = decideLink({
      profile,
      byIdentity: byIdentity
        ? { userId: byIdentity.userId, hasPassword: Boolean(byIdentity.user.passwordHash) }
        : null,
      byEmail: byEmail ? { userId: byEmail.id, hasPassword: Boolean(byEmail.passwordHash) } : null,
    });

    if (decision.kind === "REFUSE") {
      return fail(origin, decision.reason === "NO_EMAIL" ? "noemail" : "linkfirst");
    }

    if (decision.kind === "CREATE") {
      const created = await prisma.user.create({
        data: {
          email: profile.email as string,
          /*
           * Sin nombre se guarda cadena vacía, y el onboarding lo pide.
           *
           * Apple **solo manda el nombre en la primera autorización**. Si
           * alguien revoca el permiso y vuelve a entrar, o si la cuenta ya
           * existía en Apple, llega sin nombre. Rellenarlo con el trozo del
           * email de delante de la arroba deja a la gente llamándose
           * «javier.deleon91» en su propio perfil público, y como el campo
           * parece relleno nadie lo corrige.
           */
          name: profile.name ?? "",
          // Sin contraseña: esta cuenta entra por proveedor. El login por email
          // la rechaza en vez de comparar contra nada.
          passwordHash: null,
          identities: {
            create: {
              provider: profile.provider,
              subject: profile.subject,
              email: profile.email,
            },
          },
        },
        select: { id: true },
      });
      userId = created.id;
    } else {
      userId = decision.userId;
      if (decision.kind === "LINK") {
        await prisma.userIdentity.create({
          data: { userId, provider: profile.provider, subject: profile.subject, email: profile.email },
        });
      } else {
        await prisma.userIdentity.updateMany({
          where: { provider: profile.provider, subject: profile.subject },
          data: { lastUsedAt: new Date() },
        });
      }
    }
  } catch (error) {
    // Detalle al log del servidor, nada al usuario.
    console.error("[auth] fallo resolviendo la identidad", error);
    return fail(origin, "oauth");
  }

  // ── 4 y 5. sesión y destino ─────────────────────────────────────────
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      accountType: true,
      promoter: { select: { slug: true } },
      clubMemberships: { select: { club: { select: { slug: true } } }, take: 1 },
    },
  });
  if (!account) return fail(origin, "oauth");

  await createSession({ id: userId, email: account.email });

  /*
   * El destino sale de NUESTROS datos, no de lo que haya mandado el proveedor
   * en este login concreto. Apple omite el nombre a partir de la segunda vez;
   * si eso decidiera el destino, un promoter con su perfil terminado volvería
   * al onboarding cada vez que entra.
   */
  const destination = destinationFor({
    accountType: account.accountType,
    promoterSlug: account.promoter?.slug ?? null,
    clubSlug: account.clubMemberships[0]?.club.slug ?? null,
  });

  const response = NextResponse.redirect(new URL(destination, origin));
  response.cookies.set(PKCE_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
