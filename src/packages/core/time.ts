/**
 * Tiempo y "noche".
 *
 * Un evento que empieza a las 00:30 del sábado es la fiesta del viernes.
 * Si tratas el día natural como la unidad, el bot contesta "este sábado hay X"
 * señalando la fiesta equivocada. La unidad del producto es la NOCHE:
 * una noche va de las 06:00 de un día a las 06:00 del siguiente.
 */

export const NIGHT_BOUNDARY_HOUR = 6;

const WEEKDAYS_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

/** Partes de una fecha en una zona horaria concreta, sin dependencias externas. */
export function zonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const hourRaw = Number.parseInt(parts.get("hour") ?? "0", 10);
  return {
    year: Number.parseInt(parts.get("year") ?? "1970", 10),
    month: Number.parseInt(parts.get("month") ?? "1", 10),
    day: Number.parseInt(parts.get("day") ?? "1", 10),
    // Intl devuelve 24 en lugar de 0 para medianoche en algunos runtimes.
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number.parseInt(parts.get("minute") ?? "0", 10),
    weekday: weekdayMap[parts.get("weekday") ?? "Sun"] ?? 0,
  };
}

/**
 * La noche a la que pertenece un instante, como "2026-08-28".
 * Las 00:30 del sábado 29 devuelven el viernes 28.
 */
export function nightOf(date: Date, timeZone = "Europe/Madrid"): string {
  const p = zonedParts(date, timeZone);
  if (p.hour >= NIGHT_BOUNDARY_HOUR) {
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }
  const previous = new Date(date.getTime() - 24 * 3600 * 1000);
  const q = zonedParts(previous, timeZone);
  return `${q.year}-${pad(q.month)}-${pad(q.day)}`;
}

/** Nombre del día de la noche a la que pertenece el evento. "viernes", no "sábado". */
export function nightWeekdayEs(date: Date, timeZone = "Europe/Madrid"): string {
  const night = nightOf(date, timeZone);
  const [y, m, d] = night.split("-").map((n) => Number.parseInt(n, 10));
  const utc = new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12));
  return WEEKDAYS_ES[utc.getUTCDay()] as string;
}

/** "sáb 29 ago · 00:00" — corto, porque va en una tarjeta de móvil. */
export function formatEventWhen(date: Date, timeZone = "Europe/Madrid"): string {
  const day = new Intl.DateTimeFormat("es-ES", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat("es-ES", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${day} · ${time}`;
}

export function isPast(date: Date, now: Date = new Date()): boolean {
  return date.getTime() < now.getTime();
}

/**
 * Cada cuánto refrescar un evento: mucho cuando queda poco, poco cuando falta
 * una semana, nada cuando ya ha pasado. Menos peticiones a la fuente y datos
 * frescos justo cuando alguien va a preguntar el precio.
 */
export function refreshIntervalSeconds(startsAt: Date, now: Date = new Date()): number {
  const hoursUntil = (startsAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursUntil < -6) return 0; // terminado: se deja de sincronizar
  if (hoursUntil <= 48) return 600; // 10 min
  if (hoursUntil <= 168) return 3600; // 1 h
  return 21_600; // 6 h
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
