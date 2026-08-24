export * from "./types";
export * from "./parse";
export * from "./normalize";
export * from "./fourvenues";
export * from "./manual";
export * from "./fourvenues-api";

import { FourvenuesPublicSource, type FourvenuesOptions } from "./fourvenues";
import { ManualSource, type ManualEventInput } from "./manual";
import type { TicketingProvider } from "./types";

/**
 * Registro de proveedores. El resto de la aplicación pide un proveedor por
 * id y no sabe nada más. Añadir FourvenuesOfficialApi el día que exista el
 * acuerdo es registrar una entrada aquí.
 */
export function createProvider(
  id: string,
  options?: { fourvenues?: FourvenuesOptions; manual?: ManualEventInput },
): TicketingProvider {
  switch (id) {
    case "fourvenues-public":
      return new FourvenuesPublicSource(options?.fourvenues);
    case "manual":
      if (!options?.manual) throw new Error("ManualSource necesita los datos del evento");
      return new ManualSource(options.manual);
    default:
      throw new Error(`Proveedor de ticketing desconocido: ${id}`);
  }
}
