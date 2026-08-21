/**
 * Worker de sincronización.
 *
 * Vive fuera de Next y se despliega aparte, con IP estable. Dos razones: las
 * IPs rotatorias de un entorno serverless hacen el fetch inestable y parecen
 * abusivas desde el otro lado, y un job largo no debe competir con el tráfico
 * de usuarios.
 *
 *   npm run worker:refresh            # una pasada
 *   npm run worker:refresh -- --loop  # bucle continuo
 */

import { FourvenuesPublicSource } from "@nightlife/ticketing/fourvenues";
import { refreshIntervalSeconds } from "@nightlife/core/time";
import { isAppError } from "@nightlife/core/errors";
import { refreshEventFromSource } from "@nightlife/db/import";
import { expireFinishedTrials } from "@nightlife/db/subscriptions";
import {
  anonymizeExpiredConversations,
  closeEndedEvents,
  disconnect,
  listSyncCandidates,
  markSourceFailed,
} from "@nightlife/db/platform";

async function refreshDue(): Promise<void> {
  const now = new Date();
  const candidates = await listSyncCandidates();

  const due = candidates.filter((source) => {
    const interval = refreshIntervalSeconds(source.event.startsAt, now);
    if (interval === 0) return false; // evento pasado: se deja de pedir
    if (!source.lastSyncedAt) return true;
    return now.getTime() - source.lastSyncedAt.getTime() >= interval * 1000;
  });

  if (due.length === 0) {
    console.log("Nada que refrescar.");
  } else {
    console.log(`Refrescando ${due.length} evento(s).`);

    // Un único proveedor para todos: así el intervalo mínimo entre peticiones
    // se respeta de verdad, en lugar de por evento.
    const provider = new FourvenuesPublicSource({
      ...(process.env.SOURCE_CONTACT_URL ? { contactUrl: process.env.SOURCE_CONTACT_URL } : {}),
      minRequestIntervalMs: Number(process.env.SOURCE_MIN_INTERVAL_MS ?? 3000),
    });

    for (const source of due) {
      if (!source.sourceUrl) continue;
      try {
        const normalized = await provider.getEvent({ url: source.sourceUrl });
        const { pricesChanged } = await refreshEventFromSource(source.eventId, normalized);
        console.log(
          `  ✓ ${source.event.name}${pricesChanged > 0 ? ` (${pricesChanged} precio(s) nuevos)` : ""}`,
        );
      } catch (error) {
        // Si la fuente nos dice que no, se deja de pedir y se avisa al club.
        // Insistir por otra vía no es una opción.
        const permanent = isAppError(error) && error.code === "SOURCE_FORBIDDEN";
        const message = error instanceof Error ? error.message : "error desconocido";
        await markSourceFailed(source.id, message, permanent);
        console.warn(`  ✗ ${source.event.name}: ${message}`);
      }
    }
  }

  const ended = await closeEndedEvents(now);
  if (ended > 0) console.log(`${ended} evento(s) marcados como terminados.`);
}

async function main() {
  const loop = process.argv.includes("--loop");
  do {
    await refreshDue().catch((e) => console.error("refresh:", e));
    await anonymizeExpiredConversations()
      .then((n) => {
        if (n > 0) console.log(`Retención: ${n} conversación(es) anonimizadas.`);
      })
      .catch((e) => console.error("retención:", e));
    // Cierra pruebas vencidas. Solo cambia el estado: aquí no se cobra nada,
    // el cobro es de Stripe en Fase 5 y solo por el software.
    await expireFinishedTrials()
      .then((n) => {
        if (n > 0) console.log(`Suscripciones: ${n} prueba(s) vencidas.`);
      })
      .catch((e) => console.error("suscripciones:", e));
    if (loop) await new Promise((r) => setTimeout(r, 60_000));
  } while (loop);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => disconnect());
