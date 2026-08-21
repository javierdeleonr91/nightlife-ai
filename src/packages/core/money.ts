/**
 * Dinero en céntimos enteros. Nunca en float: 0.1 + 0.2 !== 0.3 y un club
 * que ve 19,99 € donde puso 20 € deja de confiar en la plataforma.
 */

export interface Money {
  readonly amountCents: number;
  readonly currency: string;
}

export function money(amountCents: number, currency = "EUR"): Money {
  if (!Number.isInteger(amountCents)) {
    throw new RangeError(`amountCents debe ser entero, recibido ${amountCents}`);
  }
  if (amountCents < 0) {
    throw new RangeError(`amountCents no puede ser negativo, recibido ${amountCents}`);
  }
  return { amountCents, currency };
}

/**
 * Formato para el cliente final. "20 €" y no "20,00 €": en nightlife los
 * precios son redondos y los decimales sobran salvo que existan.
 */
export function formatMoney(m: Money, locale = "es-ES"): string {
  const hasCents = m.amountCents % 100 !== 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(m.amountCents / 100);
}

/**
 * Convierte un precio escrito por humanos a céntimos.
 * Acepta "20", "20€", "20,50 €", "€20.50", "20.50EUR", "Gratis".
 * Devuelve null cuando no hay una lectura inequívoca — que es la respuesta
 * correcta: un parser que adivina acaba poniendo un precio falso en boca del bot.
 */
export function parseMoneyToCents(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  if (/^(gratis|free|invitaci[oó]n|0\s*€?)$/.test(text)) return 0;

  const match = text.match(/(\d{1,6})(?:[.,](\d{1,2}))?/);
  if (!match) return null;

  const whole = Number.parseInt(match[1] as string, 10);
  const fractionRaw = match[2];
  if (Number.isNaN(whole)) return null;

  let cents = whole * 100;
  if (fractionRaw !== undefined) {
    const padded = fractionRaw.length === 1 ? `${fractionRaw}0` : fractionRaw;
    cents += Number.parseInt(padded, 10);
  }
  return cents;
}

/** Céntimos presentes en un texto, para el validador anti-alucinación. */
export function extractMonetaryAmounts(text: string): number[] {
  const found: number[] = [];
  const pattern = /(?:€\s*(\d{1,6}(?:[.,]\d{1,2})?))|(?:(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|eur|euros?))/gi;
  for (const m of text.matchAll(pattern)) {
    const candidate = m[1] ?? m[2];
    if (candidate === undefined) continue;
    const cents = parseMoneyToCents(candidate);
    if (cents !== null) found.push(cents);
  }
  return found;
}
