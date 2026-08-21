/**
 * Procedencia y frescura.
 *
 * Ningún dato externo entra en el motor de conversación como valor pelado.
 * Entra como DataPoint, con de dónde salió, cuándo y cuánto nos fiamos.
 * El bot solo puede afirmar lo que sale de un DataPoint fresco y fiable;
 * todo lo demás se convierte en "no puedo confirmarlo" + CTA.
 */

export type DataSourceKind =
  | "FOURVENUES"
  | "CLUB_CONFIG"
  | "FAQ"
  | "VIP_CONFIG"
  | "CONVERSATION_CONTEXT"
  | "MANUAL";

export interface DataPoint<T> {
  readonly value: T;
  readonly source: DataSourceKind;
  readonly lastUpdated: Date;
  /** 0..1. Cómo de fiable es la extracción. Ver EXTRACTION_CONFIDENCE. */
  readonly confidence: number;
  readonly ttlSeconds: number;
  readonly field: string;
}

/** TTL por campo, en segundos. Configurable por despliegue. */
export const DEFAULT_TTL_SECONDS = {
  currentPrice: 600, // 10 min
  nextPrice: 600,
  availability: 300, // 5 min — y aun así nunca se afirma sin fuente explícita
  ticketTypes: 3600, // 1 h
  eventName: 86_400,
  startsAt: 86_400,
  dj: 86_400,
  description: 86_400,
  imageUrl: 86_400,
  ticketUrl: 604_800, // 7 días
  clubInfo: 604_800,
} as const;

export type TtlField = keyof typeof DEFAULT_TTL_SECONDS;

/**
 * Confianza según de dónde se extrajo el dato.
 * Se usa como umbral: por debajo de MIN_CONFIDENCE_TO_ASSERT el bot no afirma.
 */
export const EXTRACTION_CONFIDENCE = {
  OFFICIAL_API: 1.0,
  MANUAL_ENTRY: 1.0,
  JSON_LD: 0.9,
  HYDRATED_STATE: 0.8,
  OPEN_GRAPH: 0.6,
  HEURISTIC_HTML: 0.4,
} as const;

/** Un precio con confianza inferior a esto no llega a boca del bot. */
export const MIN_CONFIDENCE_TO_ASSERT = 0.8;

/** Por debajo de esto ni siquiera se guarda sin confirmación humana. */
export const MIN_CONFIDENCE_TO_STORE = 0.6;

export function dataPoint<T>(args: {
  value: T;
  source: DataSourceKind;
  confidence: number;
  field: string;
  ttlSeconds: number;
  lastUpdated?: Date;
}): DataPoint<T> {
  return {
    value: args.value,
    source: args.source,
    confidence: args.confidence,
    field: args.field,
    ttlSeconds: args.ttlSeconds,
    lastUpdated: args.lastUpdated ?? new Date(),
  };
}

export function isFresh(dp: DataPoint<unknown>, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - dp.lastUpdated.getTime();
  return ageMs >= 0 && ageMs < dp.ttlSeconds * 1000;
}

export function ageSeconds(dp: DataPoint<unknown>, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - dp.lastUpdated.getTime()) / 1000));
}

/**
 * La única puerta por la que un dato llega al FactSet.
 * Fresco Y suficientemente fiable, o no se puede afirmar. Sin excepciones.
 */
export function isAssertable(
  dp: DataPoint<unknown> | null | undefined,
  now: Date = new Date(),
  minConfidence: number = MIN_CONFIDENCE_TO_ASSERT,
): dp is DataPoint<unknown> {
  if (!dp) return false;
  return dp.confidence >= minConfidence && isFresh(dp, now);
}

export type Assertability =
  | { assertable: true }
  | { assertable: false; reason: "MISSING" | "STALE" | "LOW_CONFIDENCE" };

/** Igual que isAssertable pero diciendo por qué no, para logs y para el texto de fallback. */
export function assertability(
  dp: DataPoint<unknown> | null | undefined,
  now: Date = new Date(),
  minConfidence: number = MIN_CONFIDENCE_TO_ASSERT,
): Assertability {
  if (!dp) return { assertable: false, reason: "MISSING" };
  if (dp.confidence < minConfidence) return { assertable: false, reason: "LOW_CONFIDENCE" };
  if (!isFresh(dp, now)) return { assertable: false, reason: "STALE" };
  return { assertable: true };
}

/** Trazabilidad guardada junto a cada respuesta del bot. Interna, no se enseña. */
export interface ProvenanceEntry {
  readonly type: DataSourceKind;
  readonly field: string;
  readonly entityId?: string;
  readonly timestamp: string;
  readonly confidence: number;
}

export function toProvenance(dp: DataPoint<unknown>, entityId?: string): ProvenanceEntry {
  return {
    type: dp.source,
    field: dp.field,
    ...(entityId !== undefined ? { entityId } : {}),
    timestamp: dp.lastUpdated.toISOString(),
    confidence: dp.confidence,
  };
}
