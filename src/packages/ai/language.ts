/**
 * En qué idioma responder.
 *
 * La regla de producto es corta y es la correcta: **se responde en el idioma
 * del mensaje**, no en el del panel. El RRPP tiene la interfaz en español y
 * le escribe un guiri en inglés; contestarle en español porque el panel está
 * en español sería absurdo.
 *
 * Esto es un detector, no un traductor. Solo distingue español de inglés,
 * que son los dos idiomas de la beta, y ante la duda se queda con el idioma
 * anterior de la conversación. Cambiar de idioma a mitad de conversación
 * porque alguien escribió "ok" es peor que no cambiarlo nunca.
 */

export type Lang = "es" | "en";

/**
 * Palabras que solo aparecen en uno de los dos idiomas y son frecuentes en
 * mensajes cortos de nightlife. No es un modelo estadístico: es una lista de
 * señales fuertes, que para dos idiomas tan distintos basta.
 */
const EN_MARKERS = [
  "how", "much", "what", "when", "where", "who", "which", "tonight", "today",
  "tomorrow", "ticket", "tickets", "price", "cost", "open", "close", "dress",
  "code", "age", "table", "booking", "book", "buy", "link", "party", "guest",
  "list", "the", "is", "are", "do", "does", "can", "could", "please", "thanks",
  "hi", "hey", "hello", "night", "club", "entry", "entrance", "line", "up",
];

const ES_MARKERS = [
  "cuanto", "cuantos", "que", "qué", "cuando", "donde", "quien", "hoy",
  "manana", "mañana", "sabado", "sábado", "viernes", "entrada", "entradas",
  "precio", "abre", "cierra", "hora", "edad", "mesa", "reserva", "comprar",
  "enlace", "lista", "el", "la", "los", "las", "es", "son", "hay", "puedo",
  "podemos", "quiero", "gracias", "hola", "buenas", "noche", "fiesta", "con",
  "para", "somos", "vamos", "tenemos", "tienes",
];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const EN = new Set(EN_MARKERS.map((w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "")));
const ES = new Set(ES_MARKERS.map((w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "")));

export interface LanguageGuess {
  readonly lang: Lang;
  /** false cuando no hay señal suficiente y se ha usado el idioma previo. */
  readonly confident: boolean;
}

/**
 * `previous` es el idioma que ya llevaba la conversación. Se usa cuando el
 * mensaje no da señal: "ok", "vale", "mon", un emoji. Sin él, cada mensaje
 * corto sería una moneda al aire.
 */
export function detectLanguage(raw: string, previous: Lang | null = null): LanguageGuess {
  const words = tokens(raw);
  if (words.length === 0) return { lang: previous ?? "es", confident: false };

  let en = 0;
  let es = 0;
  for (const w of words) {
    // Una palabra puede estar en las dos listas ("es" es español y verbo
    // inglés). Solo cuenta cuando desempata.
    const inEn = EN.has(w);
    const inEs = ES.has(w);
    if (inEn && !inEs) en++;
    else if (inEs && !inEn) es++;
  }

  // Caracteres que en inglés no existen. Uno solo ya decide.
  if (/[ñáéíóúü¿¡]/i.test(raw)) es += 2;

  if (en === 0 && es === 0) return { lang: previous ?? "es", confident: false };
  if (en === es) return { lang: previous ?? "es", confident: false };
  return { lang: en > es ? "en" : "es", confident: true };
}
