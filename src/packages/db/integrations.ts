import { importMasterKey, seal, open, secretHint } from "@nightlife/core/secret-box";
import {
  FourvenuesApi,
  FourvenuesApiError,
  type FourvenuesChannel,
  type FourvenuesEnvironment,
} from "@nightlife/ticketing/fourvenues-api";
import { prisma } from "./client";

/**
 * Credenciales de integración de un club.
 *
 * Este módulo es la **única** puerta por la que la API key de un club entra y
 * sale. Nadie más la descifra. Las funciones que puede llamar una ruta
 * devuelven vistas seguras (`IntegrationView`) que no contienen la key ni
 * pueden contenerla, porque el tipo no la tiene.
 *
 * Todas las consultas llevan `clubId`. Una key es el activo más sensible que
 * guardamos de un cliente: el aislamiento no se delega a que el llamante se
 * acuerde.
 */

export interface IntegrationView {
  readonly provider: "FOURVENUES";
  readonly environment: FourvenuesEnvironment;
  readonly status: "NOT_CONNECTED" | "CONNECTED" | "INVALID_KEY" | "ERROR";
  /** «••••cdef». Nunca la key. */
  readonly keyHint: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly lastVerifiedAt: Date | null;
  readonly lastSyncedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly eventsSynced: number;
}

function masterKeyMaterial(): string {
  const raw = process.env.NIGHTLIFE_SECRET_KEY;
  if (!raw) {
    // Fallar aquí es correcto: sin clave maestra, guardar una key de cliente
    // en claro sería peor que no dejar conectar.
    throw new Error(
      "NIGHTLIFE_SECRET_KEY no está configurada. Sin ella no se pueden guardar credenciales de clubs.",
    );
  }
  return raw;
}

export async function getIntegration(clubId: string): Promise<IntegrationView | null> {
  const row = await prisma.clubIntegration.findUnique({
    where: { clubId_provider: { clubId, provider: "FOURVENUES" } },
    // Selección explícita: `encryptedKey` no está en la lista y no puede
    // colarse en una respuesta por descuido.
    select: {
      environment: true,
      status: true,
      keyHint: true,
      channelId: true,
      channelName: true,
      lastVerifiedAt: true,
      lastSyncedAt: true,
      lastErrorCode: true,
      eventsSynced: true,
    },
  });
  if (!row) return null;
  return { provider: "FOURVENUES", ...row } as IntegrationView;
}

/** Cliente listo para usar, con la key descifrada solo dentro de esta función. */
export async function clientFor(clubId: string): Promise<FourvenuesApi | null> {
  const row = await prisma.clubIntegration.findUnique({
    where: { clubId_provider: { clubId, provider: "FOURVENUES" } },
    select: { encryptedKey: true, environment: true, status: true },
  });
  if (!row || row.status === "NOT_CONNECTED") return null;

  const master = await importMasterKey(masterKeyMaterial());
  const apiKey = await open(row.encryptedKey, master);
  return new FourvenuesApi({ apiKey, environment: row.environment as FourvenuesEnvironment });
}

export interface ConnectResult {
  readonly ok: boolean;
  readonly channels: readonly FourvenuesChannel[];
  readonly view: IntegrationView | null;
  /** Mensaje ya apto para enseñar. Nunca técnico, nunca con la key. */
  readonly message?: string;
}

/**
 * Conectar: validar contra Fourvenues **antes** de guardar nada.
 *
 * Guardar primero y validar después dejaría al club con una integración rota
 * que dice estar conectada. Si la key no vale, aquí no se escribe una fila.
 */
export async function connectFourvenues(args: {
  clubId: string;
  apiKey: string;
  environment?: FourvenuesEnvironment;
}): Promise<ConnectResult> {
  const environment = args.environment ?? "PRODUCTION";
  const api = new FourvenuesApi({ apiKey: args.apiKey, environment });

  let channels: FourvenuesChannel[];
  try {
    channels = await api.listChannels();
  } catch (error) {
    const message =
      error instanceof FourvenuesApiError
        ? error.publicMessage
        : "We couldn't connect to Fourvenues. Check your key and try again.";
    if (error instanceof FourvenuesApiError && error.code === "INVALID_KEY") {
      await markInvalid(args.clubId);
    }
    return { ok: false, channels: [], view: await getIntegration(args.clubId), message };
  }

  const master = await importMasterKey(masterKeyMaterial());
  const encryptedKey = await seal(args.apiKey.trim(), master);
  const keyHint = secretHint(args.apiKey);
  const now = new Date();

  await prisma.clubIntegration.upsert({
    where: { clubId_provider: { clubId: args.clubId, provider: "FOURVENUES" } },
    create: {
      clubId: args.clubId,
      provider: "FOURVENUES",
      environment,
      status: "CONNECTED",
      encryptedKey,
      keyHint,
      lastVerifiedAt: now,
      // Una organización con un solo canal no merece una pantalla de elección.
      channelId: channels.length === 1 ? (channels[0]?.id ?? null) : null,
      channelName: channels.length === 1 ? (channels[0]?.name ?? null) : null,
    },
    update: {
      environment,
      status: "CONNECTED",
      encryptedKey,
      keyHint,
      lastVerifiedAt: now,
      lastErrorCode: null,
      ...(channels.length === 1
        ? { channelId: channels[0]?.id ?? null, channelName: channels[0]?.name ?? null }
        : {}),
    },
  });

  return { ok: true, channels, view: await getIntegration(args.clubId) };
}

export async function chooseChannel(args: {
  clubId: string;
  channelId: string;
  channelName: string;
}): Promise<IntegrationView | null> {
  await prisma.clubIntegration.updateMany({
    // updateMany con clubId en el where: una petición de otro club no puede
    // tocar esta fila aunque acierte el id.
    where: { clubId: args.clubId, provider: "FOURVENUES" },
    data: { channelId: args.channelId, channelName: args.channelName },
  });
  return getIntegration(args.clubId);
}

export async function disconnect(clubId: string): Promise<void> {
  // Se borra la fila entera: dejar la key cifrada «por si acaso» después de que
  // el club diga que la quita es guardar un secreto sin permiso.
  await prisma.clubIntegration.deleteMany({ where: { clubId, provider: "FOURVENUES" } });
}

export async function markInvalid(clubId: string): Promise<void> {
  await prisma.clubIntegration.updateMany({
    where: { clubId, provider: "FOURVENUES" },
    data: { status: "INVALID_KEY", lastErrorCode: "INVALID_KEY" },
  });
}

export async function markSyncResult(args: {
  clubId: string;
  eventsSynced?: number;
  errorCode?: string;
}): Promise<void> {
  await prisma.clubIntegration.updateMany({
    where: { clubId: args.clubId, provider: "FOURVENUES" },
    data: args.errorCode
      ? { status: "ERROR", lastErrorCode: args.errorCode }
      : {
          status: "CONNECTED",
          lastErrorCode: null,
          lastSyncedAt: new Date(),
          eventsSynced: args.eventsSynced ?? 0,
        },
  });
}
