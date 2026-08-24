/**
 * Qué enlace abre el botón COMPRAR.
 *
 * Regla de la spec (§50), y es de las que más fácil sería incumplir sin darse
 * cuenta: **nunca componemos una URL de compra**. Solo usamos URLs que nos ha
 * dado Fourvenues, directamente o a través de la persona que las pegó.
 *
 * Antes añadíamos `?promoter=slug` al enlace del club. Parecía inofensivo y no
 * lo es: inventa un contrato con una ticketera que no controlamos. Si ese
 * parámetro no existe, no hace nada; si existe y significa otra cosa,
 * atribuimos ventas a quien no toca. En ambos casos estamos afirmando algo que
 * no sabemos, que es exactamente lo que el resto del producto se niega a hacer
 * con los precios.
 *
 * Prioridad:
 *   1. URL propia del promoter para ese evento, si Fourvenues se la dio.
 *   2. Checkout oficial del evento (del club).
 *   3. Link personal global del promoter, si lo tiene.
 *   4. Nada — y entonces no se muestra el botón.
 *
 * El paso 3 es un fallback, no una fuente: el link global del RRPP no sirve
 * para descubrir eventos ni para saber precios. Solo evita que un cliente
 * decidido a comprar se quede sin sitio al que ir.
 */

export type CheckoutSource = "PROMOTER" | "CLUB" | "PROMOTER_GLOBAL" | "NONE";

export interface CheckoutResolution {
  readonly url: string | null;
  readonly source: CheckoutSource;
}

function isUsableUrl(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveCheckoutUrl(args: {
  /** URL oficial del evento, del club. */
  readonly clubCheckoutUrl?: string | null;
  /** URL propia del promoter para este evento, si existe. Nunca compuesta. */
  readonly promoterCheckoutUrl?: string | null;
  /** Link personal de Fourvenues del RRPP. Último recurso. */
  readonly promoterGlobalUrl?: string | null;
}): CheckoutResolution {
  if (isUsableUrl(args.promoterCheckoutUrl)) {
    return { url: args.promoterCheckoutUrl, source: "PROMOTER" };
  }
  if (isUsableUrl(args.clubCheckoutUrl)) {
    return { url: args.clubCheckoutUrl, source: "CLUB" };
  }
  if (isUsableUrl(args.promoterGlobalUrl)) {
    return { url: args.promoterGlobalUrl, source: "PROMOTER_GLOBAL" };
  }
  return { url: null, source: "NONE" };
}

/**
 * ¿Se puede enseñar el botón de compra?
 *
 * Un evento agotado no lo enseña aunque tenga URL: mandar a alguien a un
 * checkout cerrado es peor que decirle que está agotado (§52).
 */
export function canShowBuyButton(args: {
  readonly checkoutUrl: string | null;
  readonly soldOut: boolean;
}): boolean {
  return !args.soldOut && args.checkoutUrl !== null;
}

/**
 * El link personal de Fourvenues de un RRPP.
 *
 * El RRPP ya tiene el suyo: se lo da Fourvenues. Nosotros lo aceptamos tal
 * cual y **no le añadimos nada**. La única comprobación es que sea de verdad
 * un enlace de Fourvenues por https, para que no acabe en el perfil público un
 * link a cualquier otro sitio.
 *
 * Concretamente NO se hace: quitarle parámetros, añadirle los nuestros,
 * "normalizarlo", ni deducir de él un id de promoter. Lo que pegó es lo que
 * abre el cliente.
 */
export const FOURVENUES_HOSTS = ["fourvenues.com", "www.fourvenues.com"] as const;

export function normalizePromoterLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const ok = FOURVENUES_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) return null;
  // Devuelto tal cual, con sus parámetros si los trae. No se toca.
  return trimmed;
}
