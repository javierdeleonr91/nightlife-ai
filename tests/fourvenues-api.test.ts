import { describe, it, expect } from "vitest";
import {
  FourvenuesApi,
  FourvenuesApiError,
  epochSecondsToDate,
  priceToCents,
  FOURVENUES_API_CAPABILITIES,
  FOURVENUES_ENVIRONMENTS,
} from "../src/packages/ticketing/fourvenues-api";
import { MIN_CONFIDENCE_TO_ASSERT } from "../src/packages/core/provenance";
import { importMasterKey, seal, open, secretHint, redact, SecretBoxError } from "../src/packages/core/secret-box";

const KEY = "fv_live_0123456789abcdef";
const NOW = new Date("2026-03-01T12:00:00.000Z");

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stub(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = responses[Math.min(i, responses.length - 1)] as { status: number; body: unknown };
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { calls, fetchImpl };
}

function api(responses: { status: number; body: unknown }[], environment: "ALPHA" | "PRODUCTION" = "ALPHA") {
  const { calls, fetchImpl } = stub(responses);
  return {
    calls,
    client: new FourvenuesApi({
      apiKey: KEY,
      environment,
      fetchImpl,
      now: () => NOW,
      minRequestIntervalMs: 0,
      sleep: async () => {},
    }),
  };
}

describe("contrato real de la API de Fourvenues", () => {
  it("autentica con X-Api-Key contra la base del entorno elegido", async () => {
    const { client, calls } = api([{ status: 200, body: { success: true, data: [] } }], "ALPHA");
    await client.listChannels();

    expect(calls[0]!.headers["X-Api-Key"]).toBe(KEY);
    expect(calls[0]!.url.startsWith(FOURVENUES_ENVIRONMENTS.ALPHA)).toBe(true);
    expect(calls[0]!.url.includes("/channels/")).toBe(true);
  });

  it("la key nunca viaja en la URL", async () => {
    const { client, calls } = api([{ status: 200, body: { success: true, data: [] } }]);
    await client.listEvents();
    expect(calls[0]!.url.includes(KEY)).toBe(false);
  });

  it("lee los canales tal y como los documenta Fourvenues", async () => {
    const { client } = api([
      {
        status: 200,
        body: {
          success: true,
          data: [{ _id: "pw2gra4r20xlu02js0ybj42s6vYpAzeX", name: "My team", slug: "my-team" }],
        },
      },
    ]);
    const channels = await client.listChannels();
    expect(channels).toEqual([
      { id: "pw2gra4r20xlu02js0ybj42s6vYpAzeX", name: "My team", slug: "my-team" },
    ]);
  });

  it("pide los eventos con ventana start/end en formato día", async () => {
    const { client, calls } = api([{ status: 200, body: { success: true, data: [] } }]);
    await client.listEvents({ start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-03-31T00:00:00Z") });
    expect(calls[0]!.url).toContain("start=2026-03-01");
    expect(calls[0]!.url).toContain("end=2026-03-31");
  });
});

describe("errores que no filtran nada", () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: "INVALID_KEY" },
    { status: 403, code: "FORBIDDEN" },
    { status: 404, code: "NOT_FOUND" },
  ];

  for (const { status, code } of cases) {
    it(`un ${status} se traduce a ${code} sin cuerpo de respuesta`, async () => {
      const { client } = api([{ status, body: { error: `secret leak ${KEY}` } }]);
      await expect(client.listChannels()).rejects.toThrow(FourvenuesApiError);
      try {
        await client.listChannels();
      } catch (error) {
        const e = error as FourvenuesApiError;
        expect(e.code).toBe(code);
        expect(e.message.includes(KEY)).toBe(false);
        expect(e.publicMessage.includes(KEY)).toBe(false);
      }
    });
  }

  it("el mensaje público de una key mala es el que pidió el spec", async () => {
    const { client } = api([{ status: 401, body: {} }]);
    try {
      await client.listChannels();
      throw new Error("debería haber fallado");
    } catch (error) {
      expect((error as FourvenuesApiError).publicMessage).toBe(
        "We couldn't connect to Fourvenues. Check your key and try again.",
      );
    }
  });

  it("reintenta un 429 y acaba rindiéndose con RATE_LIMITED", async () => {
    const { client, calls } = api([{ status: 429, body: {} }]);
    try {
      await client.listChannels();
      throw new Error("debería haber fallado");
    } catch (error) {
      expect((error as FourvenuesApiError).code).toBe("RATE_LIMITED");
    }
    expect(calls.length).toBe(3);
  });

  it("una respuesta sin data es MALFORMED, no un evento vacío inventado", async () => {
    const { client } = api([{ status: 200, body: { success: true } }]);
    await expect(client.listEvents()).rejects.toThrow(FourvenuesApiError);
  });

  it("no acepta construirse sin key", () => {
    expect(() => new FourvenuesApi({ apiKey: "" })).toThrow(FourvenuesApiError);
  });
});

describe("normalización de eventos oficiales", () => {
  const rawEvent = {
    _id: "el4gr63f00xkq01i1d8jh5ohuzaZhvoE",
    name: "Sábado Reggaeton",
    slug: "sabado-reggaeton",
    url: "https://www.fourvenues.com/es/club/events/sabado-reggaeton",
    flyer: "https://cdn.fourvenues.com/flyer.jpg",
    description: "La noche grande",
    date: 1_772_150_400,
    start: 1_772_150_400,
    end: 1_772_172_000,
    age: 18,
    location_town: "Madrid",
    artists: ["DJ Nano", "Bizarrap"],
    active: true,
    visible: true,
  };

  it("mapea los campos que la API sí da", async () => {
    const { client } = api([{ status: 200, body: { success: true, data: [rawEvent] } }]);
    const [event] = await client.listEvents();

    expect(event!.externalId).toBe(rawEvent._id);
    expect(event!.name.value).toBe("Sábado Reggaeton");
    expect(event!.venueName?.value).toBe("Madrid");
    expect(event!.imageUrl?.value).toBe(rawEvent.flyer);
    expect(event!.ticketUrl?.value).toBe(rawEvent.url);
  });

  it("los artistas salen de su campo, no de adivinar el título", async () => {
    const { client } = api([{ status: 200, body: { success: true, data: [rawEvent] } }]);
    const [event] = await client.listEvents();
    expect(event!.dj?.value).toEqual(["DJ Nano", "Bizarrap"]);
  });

  it("la fuente oficial tiene confianza para afirmar", async () => {
    const { client } = api([{ status: 200, body: { success: true, data: [rawEvent] } }]);
    const [event] = await client.listEvents();
    expect(event!.name.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_TO_ASSERT);
  });

  it("un evento sin URL pública se marca como no comprable, no se compone una", async () => {
    const { client } = api([
      { status: 200, body: { success: true, data: [{ ...rawEvent, url: undefined }] } },
    ]);
    const [event] = await client.listEvents();
    expect(event!.ticketUrl).toBe(null);
    expect(event!.missingFields).toContain("ticketUrl");
  });

  it("nunca afirma disponibilidad: la API no publica stock", async () => {
    const { client } = api([{ status: 200, body: { success: true, data: [rawEvent] } }]);
    const [event] = await client.listEvents();
    expect(event!.availability.value).toBe("UNKNOWN");
    expect(FOURVENUES_API_CAPABILITIES.supportsAvailability).toBe(false);
  });
});

describe("escalera de precios", () => {
  const base = {
    _id: "ev1",
    name: "Noche",
    url: "https://www.fourvenues.com/es/club/events/noche",
    start: 1_772_150_400,
  };

  function withRates(options: { price: number; content?: string }[]) {
    const { client } = api([]);
    return client.normalizeApiEvent(base, [
      { _id: "r1", name: "General Access", options: options.map((o, i) => ({ _id: `o${i}`, ...o })) },
    ]);
  }

  it("con un solo precio, lo afirma", () => {
    const event = withRates([{ price: 10 }]);
    expect(event.currentPrice?.value).toBe(1000);
    expect(event.currentPrice!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_TO_ASSERT);
  });

  it("con varios precios NO los afirma, porque no sabe cuál sigue a la venta", () => {
    const event = withRates([{ price: 15 }, { price: 20 }, { price: 25 }]);
    expect(event.currentPrice?.value).toBe(1500);
    expect(event.currentPrice!.confidence).toBeLessThan(MIN_CONFIDENCE_TO_ASSERT);
    expect(event.nextPrice?.value).toBe(2000);
    expect(event.warnings.join(" ")).toMatch(/several ticket prices/i);
  });

  it("ningún tipo de entrada se marca disponible por defecto", () => {
    const event = withRates([{ price: 15 }, { price: 20 }]);
    expect(event.ticketTypes.every((t) => t.status.value === "UNKNOWN")).toBe(true);
  });

  it("los precios se guardan en céntimos y los raros se descartan", () => {
    expect(priceToCents(10)).toBe(1000);
    expect(priceToCents(12.5)).toBe(1250);
    expect(priceToCents(0)).toBe(0);
    expect(priceToCents(-1)).toBe(null);
    expect(priceToCents(999_999)).toBe(null);
    expect(priceToCents(undefined)).toBe(null);
  });

  it("las fechas epoch en segundos se leen bien y las imposibles se descartan", () => {
    expect(epochSecondsToDate(1_772_150_400)?.toISOString()).toBe("2026-02-27T00:00:00.000Z");
    expect(epochSecondsToDate(0)).toBe(null);
    expect(epochSecondsToDate(-5)).toBe(null);
    expect(epochSecondsToDate(undefined)).toBe(null);
  });
});

describe("checkout", () => {
  it("devuelve la URL de Fourvenues tal cual, sin añadir parámetros", () => {
    const { client } = api([]);
    const url = "https://www.fourvenues.com/es/club/events/noche";
    expect(client.getCheckoutUrl({ url })).toBe(url);
    expect(client.getCheckoutUrl({ url })).not.toContain("?");
  });

  it("no acepta una URL que no sea https", () => {
    const { client } = api([]);
    expect(client.getCheckoutUrl({ url: "http://fourvenues.com/x" })).toBe(null);
    expect(client.getCheckoutUrl({})).toBe(null);
  });
});

describe("secretos en reposo", () => {
  const MASTER = Buffer.alloc(32, 7).toString("base64");

  it("sella y abre el mismo valor", async () => {
    const key = await importMasterKey(MASTER);
    const sealed = await seal(KEY, key);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.includes(KEY)).toBe(false);
    expect(await open(sealed, key)).toBe(KEY);
  });

  it("dos sellados del mismo valor son distintos (nonce nuevo cada vez)", async () => {
    const key = await importMasterKey(MASTER);
    expect(await seal(KEY, key)).not.toBe(await seal(KEY, key));
  });

  it("un secreto manipulado no se abre a medias: falla", async () => {
    const key = await importMasterKey(MASTER);
    const sealed = await seal(KEY, key);
    const parts = sealed.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${(parts[2] as string).slice(0, -4)}AAAA`;
    await expect(open(tampered, key)).rejects.toThrow(SecretBoxError);
  });

  it("con otra clave maestra no se abre", async () => {
    const a = await importMasterKey(MASTER);
    const b = await importMasterKey(Buffer.alloc(32, 9).toString("base64"));
    await expect(open(await seal(KEY, a), b)).rejects.toThrow(SecretBoxError);
  });

  it("rechaza una clave maestra corta en vez de cifrar peor", async () => {
    await expect(importMasterKey(Buffer.alloc(16, 1).toString("base64"))).rejects.toThrow(SecretBoxError);
  });

  it("la pista solo enseña los cuatro últimos caracteres", () => {
    const hint = secretHint(KEY);
    expect(hint).toBe("••••cdef");
    expect(hint.includes(KEY)).toBe(false);
  });

  it("redact borra el secreto de cualquier texto", () => {
    expect(redact(`falló con ${KEY} al final`, KEY)).toBe("falló con [redacted] al final");
    expect(redact("sin secretos", null, undefined)).toBe("sin secretos");
  });
});
