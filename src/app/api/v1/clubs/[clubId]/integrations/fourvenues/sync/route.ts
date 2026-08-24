import { z } from "zod";
import { NextResponse } from "next/server";
import { assertPermission, forTenant, syncFourvenues } from "@nightlife/db";
import { apiError, parseBody } from "@/lib/api";
import { requirePrincipalApi } from "@/lib/require-api";

/**
 * Sincronizar los eventos del club desde Fourvenues.
 *
 * `dryRun` lee sin escribir: es lo que alimenta el «8 events found» antes de
 * que el club confirme. Sin él, la primera pantalla ya habría modificado su
 * base de datos, que es exactamente lo que no debe hacer una previsualización.
 */

const schema = z.object({
  dryRun: z.boolean().default(false),
  days: z.number().int().min(1).max(365).default(120),
});

export async function POST(request: Request, { params }: { params: Promise<{ clubId: string }> }) {
  try {
    const principal = await requirePrincipalApi();
    const { clubId } = await params;
    assertPermission(principal, clubId, "source:import");

    const body = await parseBody(request, schema);
    const report = await syncFourvenues({ clubId, days: body.days, dryRun: body.dryRun });

    if (!body.dryRun) {
      await forTenant(principal, clubId).audit("club.integration.sync", {
        provider: "FOURVENUES",
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
      });
    }

    return NextResponse.json(report, { status: report.ok ? 200 : 400 });
  } catch (error) {
    return apiError(error);
  }
}
