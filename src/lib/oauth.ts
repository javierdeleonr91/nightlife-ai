import "server-only";

/**
 * Configuración de Supabase Auth. Solo servidor.
 *
 * Supabase actúa de intermediario del OAuth (ver core/oauth.ts). Lo único que
 * necesitamos es la URL del proyecto y la clave anónima, que es la que va en la
 * cabecera `apikey` del canje.
 *
 * La clave anónima está diseñada para poder ser pública, pero aquí no hace
 * falta que lo sea: todo el flujo ocurre en el servidor, así que se queda sin
 * prefijo NEXT_PUBLIC. Menos superficie por nada a cambio.
 *
 * Los secretos de Google y Apple NO están aquí. Viven en el panel de Supabase.
 */

/**
 * Nombre de la cookie httpOnly donde viaja el verificador PKCE entre
 * /auth/start y /auth/callback.
 *
 * Vive aquí y no en la ruta que la escribe porque un `route.ts` de Next solo
 * puede exportar handlers y unas pocas opciones de configuración; cualquier
 * otra exportación rompe el build con «is not a valid Route export field».
 * Las dos rutas la importan de este módulo.
 */
export const PKCE_COOKIE = "nl_pkce";

export interface SupabaseAuthConfig {
  readonly supabaseUrl: string;
  readonly anonKey: string;
}

export function oauthConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

export function supabaseAuthConfig(): SupabaseAuthConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error("SUPABASE_URL y SUPABASE_ANON_KEY hacen falta para el acceso con proveedor.");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey };
}
