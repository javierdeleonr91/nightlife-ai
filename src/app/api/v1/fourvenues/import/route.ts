import { z } from "zod";
import { NextResponse } from "next/server";
import { formatMoney, money } from "@nightlife/core/money";
import { MIN_CONFIDENCE_TO_ASSERT } from "@nightlife/core/provenance";
import { FourvenuesPublicSource } from "@nightlife/ticketing";
import { assertPermission } from "@nightlife/db";
import { env } from "@nightlife/config/env";
import { apiError, parseBody, rateLimit } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

const schema = z.object({
  clubId: z.string().min(1),
  url: z.string().url(),
});

/**
 * Paso 1 del import: leer y previsualizar. NO guarda nada.
 *
 * La confirmación humana no es burocracia: es la barrera que impide que un
 * cambio de maquetación en la fuente meta un precio equivocado en boca del
 * bot. El club ve lo detectado, lo corrige y firma.
 */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipalApi();
    const body = await parseBody(request, schema);
    assertPermission(principal, body.clubId, "source:import");

    // Importar es caro para la fuente: se limita por club, no por IP.
    rateLimit(`import:${body.clubId}`, 20, 3600);

    const source = new FourvenuesPublicSource({
      contactUrl: env().SOURCE_CONTACT_URL,
      minRequestIntervalMs: env().SOURCE_MIN_INTERVAL_MS,
    });
    const event = await source.getEvent({ url: body.url });

    const preview = {
      name: event.name.value,
      startsAt: event.startsAt?.value ?? null,
      venue: event.venueName?.value ?? null,
      description: event.description?.value ?? null,
      imageUrl: event.imageUrl?.value ?? null,
      djs: event.dj?.value ?? [],
      ticketUrl: event.ticketUrl?.value ?? null,
      currentPrice: event.currentPrice
        ? {
            formatted: formatMoney(money(event.currentPrice.value)),
            amountCents: event.currentPrice.value,
            confidence: event.currentPrice.confidence,
            // El club necesita saber esto antes de firmar: si es false, el
            // bot no dirá el precio aunque el club confirme el evento.
            usableByBot: event.currentPrice.confidence >= MIN_CONFIDENCE_TO_ASSERT,
          }
        : null,
      nextPrice: event.nextPrice ? formatMoney(money(event.nextPrice.value)) : null,
      availability: event.availability.value,
      ticketTypes: event.ticketTypes.map((t) => ({
        name: t.name,
        price: t.priceCents ? formatMoney(money(t.priceCents.value)) : null,
        status: t.status.value,
      })),
      missingFields: event.missingFields,
      warnings: event.warnings,
      sourceUrl: event.sourceUrl,
    };

    return NextResponse.json({ preview, raw: event });
  } catch (error) {
    return apiError(error);
  }
}
