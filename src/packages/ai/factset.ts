/**
 * FactSet — el conjunto cerrado de cosas que el bot tiene derecho a afirmar.
 *
 * Se construye ANTES de generar, a partir de DataPoints frescos y fiables.
 * Todo lo que no entre aquí, el bot no puede decirlo, y el validador lo
 * comprueba después. Un dato caducado sencillamente no llega al FactSet, así
 * que la respuesta "está a 20 €" con un precio de hace dos horas no es que
 * esté desaconsejada: es imposible de enviar.
 */

import { assertability, type DataPoint, type ProvenanceEntry, toProvenance } from "@nightlife/core/provenance";
import type { AvailabilityState } from "@nightlife/ticketing/types";

export interface FactSet {
  /** Importes en céntimos que la respuesta puede mencionar. */
  readonly amountsCents: readonly number[];
  /** URLs exactas que la respuesta puede enlazar. */
  readonly urls: readonly string[];
  /** Nombres propios verificados: eventos, DJs, opciones VIP. */
  readonly entities: readonly string[];
  /** Fechas en ISO que se pueden citar. */
  readonly dates: readonly string[];
  /** Números no monetarios permitidos: edad mínima, aforos VIP, horas. */
  readonly numbers: readonly number[];
  readonly claims: {
    readonly availability: AvailabilityState;
    readonly hasKnownDjs: boolean;
    readonly hasKnownMinAge: boolean;
    readonly hasKnownDressCode: boolean;
    readonly hasVipOptions: boolean;
  };
  /** Campos que existían pero llegaron caducados o poco fiables. Para el log. */
  readonly unavailable: readonly { field: string; reason: string }[];
  readonly provenance: readonly ProvenanceEntry[];
}

export interface FactSetInput {
  readonly now?: Date;
  readonly currentPrice?: DataPoint<number> | null;
  readonly nextPrice?: DataPoint<number> | null;
  readonly historicalPricesCents?: readonly number[];
  readonly availability?: DataPoint<AvailabilityState> | null;
  readonly eventName?: DataPoint<string> | null;
  readonly startsAt?: DataPoint<string> | null;
  readonly djs?: DataPoint<string[]> | null;
  readonly ticketUrl?: DataPoint<string> | null;
  readonly minAge?: number | null;
  readonly dressCode?: string | null;
  readonly vipOptions?: readonly { name: string; priceCents: number | null; minPax: number; maxPax: number }[];
  readonly extraUrls?: readonly string[];
}

export function buildFactSet(input: FactSetInput): FactSet {
  const now = input.now ?? new Date();
  const amounts = new Set<number>();
  const urls = new Set<string>();
  const entities = new Set<string>();
  const dates = new Set<string>();
  const numbers = new Set<number>();
  const unavailable: { field: string; reason: string }[] = [];
  const provenance: ProvenanceEntry[] = [];

  const take = <T>(dp: DataPoint<T> | null | undefined, onOk: (value: T) => void): void => {
    if (!dp) return;
    const verdict = assertability(dp, now);
    if (verdict.assertable) {
      onOk(dp.value);
      provenance.push(toProvenance(dp));
    } else {
      unavailable.push({ field: dp.field, reason: verdict.reason });
    }
  };

  take(input.currentPrice, (cents) => amounts.add(cents));
  take(input.nextPrice, (cents) => amounts.add(cents));
  for (const cents of input.historicalPricesCents ?? []) amounts.add(cents);

  take(input.eventName, (name) => entities.add(name));
  take(input.startsAt, (iso) => dates.add(iso));
  take(input.djs, (list) => {
    for (const dj of list) entities.add(dj);
  });
  take(input.ticketUrl, (url) => urls.add(url));

  let availability: AvailabilityState = "UNKNOWN";
  take(input.availability, (state) => {
    availability = state;
  });

  for (const url of input.extraUrls ?? []) urls.add(url);

  if (typeof input.minAge === "number") numbers.add(input.minAge);

  const vip = input.vipOptions ?? [];
  for (const option of vip) {
    entities.add(option.name);
    if (option.priceCents !== null) amounts.add(option.priceCents);
    numbers.add(option.minPax);
    numbers.add(option.maxPax);
  }

  return {
    amountsCents: [...amounts],
    urls: [...urls],
    entities: [...entities],
    dates: [...dates],
    numbers: [...numbers],
    claims: {
      availability,
      hasKnownDjs: (input.djs?.value?.length ?? 0) > 0 && !unavailable.some((u) => u.field === "dj"),
      hasKnownMinAge: typeof input.minAge === "number",
      hasKnownDressCode: typeof input.dressCode === "string" && input.dressCode.length > 0,
      hasVipOptions: vip.length > 0,
    },
    unavailable,
    provenance,
  };
}

/** Resumen legible que se inyecta en el prompt. Nada más entra en el contexto. */
export function factSetToPromptBlock(facts: FactSet, formatMoney: (cents: number) => string): string {
  const lines: string[] = [];
  if (facts.amountsCents.length > 0) {
    lines.push(`Importes permitidos: ${facts.amountsCents.map(formatMoney).join(", ")}`);
  }
  if (facts.entities.length > 0) lines.push(`Nombres permitidos: ${facts.entities.join(", ")}`);
  if (facts.urls.length > 0) lines.push(`Enlaces permitidos: ${facts.urls.join(", ")}`);
  lines.push(`Disponibilidad conocida: ${facts.claims.availability}`);
  if (facts.unavailable.length > 0) {
    lines.push(
      `NO se sabe (no lo afirmes): ${facts.unavailable.map((u) => `${u.field} (${u.reason})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}
