import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@nightlife/auth";
import { destroySession } from "@/lib/session";

/**
 * Cerrar sesión.
 *
 * Se limpia por partida doble: en el almacén de cookies (`destroySession`) y
 * en la respuesta. La segunda es la que importa cuando hay una CDN o un proxy
 * por delante, porque es una cabecera `Set-Cookie` explícita en ESTA respuesta
 * y no depende de que nadie más la propague.
 *
 * `no-store` para que la respuesta no se cachee: una respuesta de logout
 * servida desde caché es un logout que a veces no ocurre.
 */
export async function POST() {
  await destroySession();

  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
