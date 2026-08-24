/**
 * Entrar con Google o con Apple.
 *
 * Decisión de arquitectura, y conviene entenderla antes de tocar nada:
 *
 * **Supabase Auth se usa solo como intermediario del OAuth.** La sesión de la
 * aplicación sigue siendo la nuestra (`nl_session`). El flujo es:
 *
 *   navegador → Supabase /authorize → Google/Apple → Supabase → nuestro
 *   /auth/callback → canjeamos el código → sabemos quién es → creamos NUESTRA
 *   sesión → la de Supabase se descarta
 *
 * Por qué así y no cada cosa por separado:
 *
 *  · Los secretos de Google y Apple viven en el panel de Supabase y no en
 *    nuestro `.env` ni en el repositorio. El `.p8` de Apple no llega a tocar
 *    este código en ningún momento.
 *  · Supabase trae la herramienta que firma el client secret de Apple a partir
 *    del `.p8`, que si no habría que implementar aquí (JWT ES256).
 *  · Al quedarnos con una sola sesión, cerrar sesión funciona igual entrara
 *    como entrara: el middleware, el RBAC y el logout no cambian ni una línea.
 *
 * **Lo que Supabase NO hace: rotar el secreto de Apple.** Su documentación es
 * explícita — «Apple requires you to generate a new secret key every 6 months»
 * — y recomienda ponerse un recordatorio en el calendario. Es una tarea manual
 * y recurrente: si se pasa la fecha, el acceso con Apple deja de funcionar sin
 * previo aviso y el error que se ve no dice nada de secretos caducados. El
 * procedimiento está en `docs/apple-secret-rotation.md`.
 *
 * Y lo que **no** hacemos: guardar los tokens de Google o de Apple. OAuth aquí
 * sirve para saber quién eres, no para leer tu correo. El token cumple su
 * función en el callback y se tira.
 */

export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Cómo puede entrar alguien.
 *
 * `UserIdentity` guarda **solo identidades externas** (Google, Apple). La
 * contraseña no es una fila ahí: vive en `User.passwordHash`, que es donde
 * siempre estuvo. Duplicarla como identidad crearía dos sitios donde mirar
 * para responder a la misma pregunta, y obligaría a un backfill de todas las
 * cuentas que ya existen para no ganar nada.
 *
 * Los métodos de una persona se calculan con `signInMethodsFor` a partir de
 * las dos fuentes.
 */
export type SignInMethod = OAuthProvider | "password";

const SIGN_IN_LABELS: Record<SignInMethod, { es: string; en: string }> = {
  google: { es: "Google", en: "Google" },
  apple: { es: "Apple", en: "Apple" },
  password: { es: "Email y contraseña", en: "Email and password" },
};

/**
 * Cómo se enseña un método en Ajustes.
 *
 * Acepta `string` en vez de exigir `SignInMethod` porque el valor viene de una
 * columna de texto: si algún día hay una fila con un proveedor que este código
 * no conoce, la pantalla debe enseñar algo razonable en vez de romperse. Sin
 * casts para convencer al compilador de algo que no puede saber.
 */
export function signInMethodLabel(method: string, locale: "es" | "en"): string {
  const known = SIGN_IN_LABELS[method as SignInMethod];
  if (known) return known[locale];
  // Un proveedor desconocido se enseña capitalizado y ya está.
  return method.charAt(0).toUpperCase() + method.slice(1);
}

/**
 * Con qué puede entrar esta persona.
 *
 * Se lee de las dos fuentes a la vez porque un usuario puede tener varias:
 * quien se registró con contraseña y después vinculó Google tiene dos, y en
 * Ajustes tienen que salir las dos.
 */
export function signInMethodsFor(account: {
  hasPassword: boolean;
  identityProviders: readonly string[];
}): SignInMethod[] {
  const methods: SignInMethod[] = [];
  if (account.hasPassword) methods.push("password");
  for (const provider of account.identityProviders) {
    if (isOAuthProvider(provider) && !methods.includes(provider)) methods.push(provider);
  }
  return methods;
}

// ── PKCE ──────────────────────────────────────────────────────────────

/**
 * PKCE, y por qué hace falta aunque el intercambio sea servidor a servidor.
 *
 * El código de autorización viaja en la URL de vuelta del navegador: queda en
 * el historial, en los logs del proxy y en el Referer. PKCE hace que ese código
 * no sirva para nada sin el verificador, que nunca sale de nuestro servidor —
 * va en una cookie httpOnly y se borra al usarse.
 */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

const VERIFIER_BYTES = 64;

function b64url(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkcePair(randomBytes?: Uint8Array): Promise<PkcePair> {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES));
  const verifier = b64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/**
 * La URL a la que se manda al navegador.
 *
 * Contrato real de Supabase (comprobado contra el código de `auth-js`):
 *   GET {supabaseUrl}/auth/v1/authorize
 *       ?provider=...&redirect_to=...&code_challenge=...&code_challenge_method=s256
 */
export function authorizeUrl(args: {
  supabaseUrl: string;
  provider: OAuthProvider;
  redirectTo: string;
  challenge: string;
}): string {
  const base = args.supabaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/auth/v1/authorize`);
  url.searchParams.set("provider", args.provider);
  url.searchParams.set("redirect_to", args.redirectTo);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

/** Endpoint de canje. `POST {supabaseUrl}/auth/v1/token?grant_type=pkce`. */
export function tokenExchangeUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`;
}

// ── vinculación de cuentas ────────────────────────────────────────────

/** Lo que sabemos de quien acaba de autenticarse. */
export interface ProviderProfile {
  readonly provider: OAuthProvider;
  /** El `sub`. Lo único estable que da un proveedor. */
  readonly subject: string;
  readonly email: string | null;
  /** ¿El proveedor dice haber verificado ese email? */
  readonly emailVerified: boolean;
  readonly name: string | null;
}

/** Lo que hay ya en nuestra base de datos para ese email o ese subject. */
export interface ExistingAccount {
  readonly userId: string;
  /** ¿Tiene contraseña? Cambia qué es seguro hacer. */
  readonly hasPassword: boolean;
}

export type LinkDecision =
  /** Ya conocíamos esta identidad: entra y punto. */
  | { readonly kind: "SIGN_IN"; readonly userId: string }
  /** Mismo email, verificado por el proveedor: se vincula y entra. */
  | { readonly kind: "LINK"; readonly userId: string }
  /** Nadie con ese email: cuenta nueva. */
  | { readonly kind: "CREATE" }
  /** No se puede decidir con seguridad. Nunca se crea ni se vincula a ciegas. */
  | { readonly kind: "REFUSE"; readonly reason: LinkRefusal };

export type LinkRefusal = "NO_EMAIL" | "UNVERIFIED_EMAIL";

export function linkRefusalMessage(reason: LinkRefusal, locale: "es" | "en"): string {
  const messages: Record<LinkRefusal, { es: string; en: string }> = {
    NO_EMAIL: {
      es: "Ese proveedor no nos ha dado tu email, así que no podemos crear la cuenta. Entra con email y contraseña.",
      en: "That provider didn't share your email, so we can't create the account. Sign in with email and password instead.",
    },
    UNVERIFIED_EMAIL: {
      es: "Ya existe una cuenta con ese email. Entra con tu contraseña y después podrás vincular el proveedor.",
      en: "An account with that email already exists. Sign in with your password first, then you can link the provider.",
    },
  };
  return messages[reason][locale];
}

/**
 * Qué hacer con alguien que acaba de autenticarse con Google o Apple.
 *
 * La regla que importa es la tercera. Alguien creó su cuenta con email y
 * contraseña; meses después pulsa «Continuar con Google» con el mismo email.
 * Hay tres respuestas posibles y solo una es correcta:
 *
 *  · crear una segunda cuenta → acaba con dos perfiles y sin entender por qué
 *    su club ha desaparecido;
 *  · vincular sin comprobar nada → cualquiera que registre ese email en un
 *    proveedor cualquiera entra en la cuenta ajena;
 *  · vincular **solo si el proveedor ha verificado el email** → correcto, y es
 *    lo que hacemos. Google y Apple verifican siempre; si alguna vez llega un
 *    `email_verified: false`, se rechaza y se le pide entrar con su contraseña.
 *
 * Nada aquí infiere si es RRPP o discoteca. Eso lo elige la persona después.
 *
 * **Limitación conocida: «Hide My Email» de Apple.** Quien la usa nos llega con
 * una dirección `@privaterelay.appleid.com` distinta de la que tenga en su
 * cuenta de contraseña o de Google. Para nosotros son dos personas distintas, y
 * **así debe ser**: adivinar que son la misma sería vincular cuentas por
 * parecido, que es exactamente el agujero que la regla del email verificado
 * existe para cerrar. No hay forma correcta de deducirlo desde el servidor.
 *
 * La solución no es adivinar, es preguntar: vincular proveedores desde Ajustes
 * estando ya autenticado, donde la propia persona confirma que las dos cuentas
 * son suyas. Está pendiente.
 */
export function decideLink(args: {
  profile: ProviderProfile;
  /** Cuenta ya vinculada a (provider, subject), si la hay. */
  byIdentity: ExistingAccount | null;
  /** Cuenta con ese email, si la hay. */
  byEmail: ExistingAccount | null;
}): LinkDecision {
  // 1. Ya le conocíamos por este proveedor. Es el camino normal a partir de la
  //    segunda vez, y no depende del email: si cambió su correo en Google,
  //    sigue siendo la misma persona.
  if (args.byIdentity) return { kind: "SIGN_IN", userId: args.byIdentity.userId };

  // 2. Sin email no hay forma de saber si ya tiene cuenta. Crear una a ciegas
  //    sería duplicarle el perfil.
  if (!args.profile.email) return { kind: "REFUSE", reason: "NO_EMAIL" };

  // 3. Hay una cuenta con ese email y no es esta identidad.
  if (args.byEmail) {
    if (!args.profile.emailVerified) return { kind: "REFUSE", reason: "UNVERIFIED_EMAIL" };
    return { kind: "LINK", userId: args.byEmail.userId };
  }

  // 4. Nadie con ese email: cuenta nueva.
  return { kind: "CREATE" };
}

/**
 * A dónde va alguien después de entrar.
 *
 * Un usuario social nuevo no tiene perfil todavía, y Google no dice si lleva un
 * club o hace RRPP. Va al selector. Quien ya tiene perfil va a su panel: hacerle
 * pasar otra vez por «¿cómo vas a usar la plataforma?» sería preguntarle algo
 * que ya contestó.
 */
export function destinationFor(account: {
  accountType: "CLUB" | "PROMOTER" | null;
  /** Hay perfil de promoter creado. Su presencia ES la señal de «completado». */
  promoterSlug: string | null;
  /** Pertenece a un club. Misma idea. */
  clubSlug: string | null;
}): string {
  if (account.accountType === "PROMOTER" && account.promoterSlug) return "/promoter/home";
  if (account.accountType === "CLUB" && account.clubSlug) return `/club/${account.clubSlug}/overview`;
  return "/onboarding";
}

/**
 * ¿Hay que pedirle el nombre en el onboarding?
 *
 * Deliberadamente **separado de `destinationFor`**, y esa separación arregla un
 * fallo que tuve: encadenar «no hay nombre» con «vete a onboarding» mandaba a
 * un RRPP con su perfil terminado de vuelta al onboarding **en cada login con
 * Apple**, porque Apple solo entrega el nombre en la primera autorización.
 *
 * A dónde va alguien lo deciden NUESTROS datos: si tiene perfil, va a su panel.
 * Que Apple mande o no el nombre en un login concreto no dice absolutamente
 * nada sobre si terminó de configurarse hace seis meses.
 *
 * Esta función solo se consulta **dentro** del onboarding, para decidir si hay
 * que enseñar el campo del nombre. Una vez guardado, es nuestro y no volvemos a
 * preguntárselo a Apple.
 */
export function needsName(user: { name: string | null }): boolean {
  return (user.name ?? "").trim().length === 0;
}
