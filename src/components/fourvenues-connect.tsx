"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckMark, Icon } from "@/components/ui";

/**
 * Conectar Fourvenues.
 *
 * No parece una pantalla de configuración de API y es deliberado: quien la usa
 * lleva un club, no un backend. Pide una cosa, explica dónde encontrarla y
 * cuenta lo que va pasando.
 *
 * El teatro no miente, misma regla que el import: las etapas avanzan mientras
 * la petición está de verdad en vuelo y la última la cierra la respuesta. Cada
 * etapa se corresponde con una llamada real — verificar la key, listar canales,
 * leer eventos, leer tarifas.
 *
 * La key sale de este componente en el cuerpo de un POST y **no vuelve nunca**.
 * No se guarda en estado después de mandarla, no se pone en localStorage, no
 * viaja en la URL. Lo único que vuelve del servidor es «••••cdef».
 */

const STAGES = [
  { key: "secure", label: "Conectando de forma segura…" },
  { key: "account", label: "Comprobando tu cuenta…" },
  { key: "venues", label: "Buscando locales…" },
  { key: "events", label: "Buscando eventos…" },
  { key: "tickets", label: "Leyendo información de entradas…" },
] as const;

interface Channel {
  id: string;
  name: string;
  slug: string;
}

interface FoundEvent {
  id: string;
  name: string;
  startsAt: string | null;
  imageUrl: string | null;
  isNew: boolean;
}

type Phase = "idle" | "connecting" | "channel" | "found" | "saving" | "done";

export function FourvenuesConnect({
  clubId,
  connected,
  keyHint,
  channelName,
}: {
  clubId: string;
  connected: boolean;
  keyHint: string | null;
  channelName: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [showForm, setShowForm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState<"PRODUCTION" | "ALPHA">("PRODUCTION");
  const [stage, setStage] = useState(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [events, setEvents] = useState<FoundEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/v1/clubs/${clubId}/integrations/fourvenues`;

  async function connect(submit: React.FormEvent) {
    submit.preventDefault();
    const key = apiKey.trim();
    if (key.length < 8) return;

    setPhase("connecting");
    setError(null);
    setStage(0);
    const ticker = setInterval(() => setStage((s) => Math.min(s + 1, 2)), 600);

    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key, environment }),
      });
      const data = await response.json();
      clearInterval(ticker);

      if (!response.ok || !data.ok) {
        // El mensaje viene ya redactado del servidor. Nunca hay detalle
        // técnico ni eco de la key.
        setError(data.message ?? "No hemos podido conectar con Fourvenues. Comprueba tu clave e inténtalo de nuevo.");
        setPhase("idle");
        return;
      }

      // La key ha cumplido su función. Fuera del estado del componente.
      setApiKey("");
      setChannels(data.channels ?? []);
      setStage(3);

      if ((data.channels?.length ?? 0) > 1) {
        setPhase("channel");
        return;
      }
      await preview();
    } catch {
      clearInterval(ticker);
      setError("No hemos podido conectar con Fourvenues. Comprueba tu clave e inténtalo de nuevo.");
      setPhase("idle");
    }
  }

  /** Lee sin escribir: enseña lo que hay antes de tocar la base de datos. */
  async function preview() {
    setPhase("connecting");
    setStage(4);
    try {
      const response = await fetch(`${base}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setError(data.message ?? "No hemos podido leer tus eventos. Inténtalo de nuevo en unos instantes.");
        setPhase("idle");
        return;
      }
      setStage(STAGES.length);
      setEvents(data.events ?? []);
      setTimeout(() => setPhase("found"), 380);
    } catch {
      setError("No hemos podido leer tus eventos. Inténtalo de nuevo en unos instantes.");
      setPhase("idle");
    }
  }

  async function pickChannel(channel: Channel) {
    await fetch(`${base}/channel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, channelName: channel.name }),
    });
    await preview();
  }

  /** Ahora sí se escribe. */
  async function confirm() {
    setPhase("saving");
    try {
      const response = await fetch(`${base}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setError(data.message ?? "No hemos podido guardar tus eventos. Inténtalo de nuevo en unos instantes.");
        setPhase("found");
        return;
      }
      setPhase("done");
      router.refresh();
    } catch {
      setError("No hemos podido guardar tus eventos. Inténtalo de nuevo en unos instantes.");
      setPhase("found");
    }
  }

  async function disconnect() {
    await fetch(base, { method: "DELETE" });
    setPhase("idle");
    setShowForm(false);
    setEvents([]);
    setChannels([]);
    router.refresh();
  }

  // ── ya conectado ────────────────────────────────────────────────────

  if (connected && phase === "idle" && !showForm) {
    return (
      <div className="nl-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="nl-display text-[1.15rem]">Fourvenues conectado</p>
            <p className="nl-dim mt-1 text-[0.8125rem]">
              Clave {keyHint ?? "••••"}
              {channelName ? ` · ${channelName}` : ""}
            </p>
          </div>
          <span style={{ color: "var(--nl-live)" }}>
            <CheckMark size={26} />
          </span>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={preview} className="nl-btn nl-btn--hot">
            <Icon name="refresh" size={17} />
            Sincronizar ahora
          </button>
          <button type="button" onClick={() => setShowForm(true)} className="nl-btn nl-btn--ghost">
            Cambiar clave
          </button>
          <button type="button" onClick={disconnect} className="nl-btn nl-btn--ghost">
            Desconectar
          </button>
        </div>
      </div>
    );
  }

  // ── progreso ────────────────────────────────────────────────────────

  if (phase === "connecting" || phase === "saving") {
    return (
      <div className="nl-card p-5">
        <p className="nl-display mb-4 text-[1.15rem]">
          {phase === "saving" ? "Guardando tus eventos…" : "Conectando con Fourvenues"}
        </p>
        <div className="nl-progress mb-5">
          <span
            className="nl-progress__bar"
            style={{ width: `${Math.round(((stage + 1) / STAGES.length) * 100)}%` }}
          />
        </div>
        <ul className="grid gap-2.5">
          {STAGES.map((s, i) => {
            const state = i < stage ? "done" : i === stage ? "active" : "idle";
            return (
              <li key={s.key} className={`nl-stage ${state === "idle" ? "" : `nl-stage--${state}`}`}>
                <span className="nl-stage__mark">
                  {state === "done" ? <CheckMark size={13} /> : null}
                </span>
                {s.label}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // ── elegir canal ────────────────────────────────────────────────────

  if (phase === "channel") {
    return (
      <div className="nl-card p-5">
        <p className="nl-display text-[1.15rem]">¿Cuál de estos locales es este club?</p>
        <p className="nl-muted mt-1 text-[0.9375rem]">
          Tu cuenta de Fourvenues tiene más de un local. Elige el que corresponde a este club.
        </p>
        <div className="mt-4 grid gap-2">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => pickChannel(channel)}
              className="nl-integration text-left"
            >
              <span className="nl-integration__logo" aria-hidden="true">
                <Icon name="crown" size={20} />
              </span>
              <span className="min-w-0 flex-1 font-semibold">{channel.name}</span>
              <Icon name="arrow" size={18} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── eventos encontrados ─────────────────────────────────────────────

  if (phase === "found" || phase === "done") {
    return (
      <div className="nl-card p-5">
        <div className="flex items-center gap-3">
          <span style={{ color: "var(--nl-live)" }}>
            <CheckMark size={26} />
          </span>
          <p className="nl-display text-[1.35rem]">
            {phase === "done"
              ? "Fourvenues conectado"
              : `${events.length} ${events.length === 1 ? "evento" : "eventos"} encontrados`}
          </p>
        </div>

        {events.length > 0 ? (
          <div className="nl-stagger mt-5 grid gap-2">
            {events.slice(0, 12).map((event) => (
              <div key={event.id} className="nl-integration">
                <span
                  className="nl-integration__logo"
                  aria-hidden="true"
                  style={
                    event.imageUrl
                      ? {
                          backgroundImage: `url(${event.imageUrl})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : undefined
                  }
                >
                  {event.imageUrl ? null : <Icon name="calendar" size={20} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{event.name}</p>
                  <p className="nl-dim text-[0.8125rem]">
                    {event.startsAt
                      ? new Date(event.startsAt).toLocaleDateString("es-ES", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                        })
                      : "Sin fecha"}
                  </p>
                </div>
              </div>
            ))}
            {events.length > 12 ? (
              <p className="nl-dim text-[0.8125rem]">y {events.length - 12} más</p>
            ) : null}
          </div>
        ) : (
          <p className="nl-muted mt-4 text-[0.9375rem]">
            Tu cuenta está conectada, pero todavía no hay próximos eventos en Fourvenues. Crea uno
            allí y vuelve a sincronizar.
          </p>
        )}

        {error ? <p className="nl-error mt-4">{error}</p> : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {phase === "found" && events.length > 0 ? (
            <button type="button" onClick={confirm} className="nl-btn nl-btn--hot">
              Sincronizar estos eventos
            </button>
          ) : null}
          <button type="button" onClick={() => setPhase("idle")} className="nl-btn nl-btn--ghost">
            Listo
          </button>
        </div>
      </div>
    );
  }

  // ── formulario ──────────────────────────────────────────────────────

  return (
    <div className="nl-card p-5">
      <p className="nl-display text-[1.35rem]">Conectar Fourvenues</p>
      <p className="nl-muted mt-2 text-[0.9375rem]">
        Tus eventos siguen estando en Fourvenues. Nosotros los leemos para que tu página pública y tu asistente
        muestren siempre lo que realmente estás vendiendo, sin tener que introducir la información dos veces.
      </p>

      <form onSubmit={connect} className="mt-5 grid gap-4">
        <div className="nl-field">
          <label className="nl-label" htmlFor="fv-key">
            Clave de integración
          </label>
          <input
            id="fv-key"
            className="nl-input nl-input--mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Pega tu clave"
          />
          <p className="nl-hint">
            Se guarda cifrada y nunca vuelve a mostrarse completa; solo verás los últimos cuatro
            caracteres.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="nl-back w-fit"
          aria-expanded={showHelp}
        >
          ¿Dónde encuentro mi clave?
        </button>

        {showHelp ? (
          <div className="nl-card nl-card--flat p-4">
            <ol className="grid gap-2 text-[0.9375rem]">
              <li>1. Inicia sesión en Fourvenues con la cuenta de tu organización.</li>
              <li>
                2. Abre <strong>Configuración → Portal de desarrolladores</strong>.
              </li>
              <li>3. Crea una clave de integración y cópiala.</li>
              <li>4. Pégala arriba.</li>
            </ol>
            <p className="nl-hint mt-3">
              Si no ves el Portal de desarrolladores, puede que tu plan de Fourvenues necesite tenerlo activado;
              puedes solicitarlo en integrations@fourvenues.com.
            </p>
          </div>
        ) : null}

        <details className="nl-hint">
          <summary className="cursor-pointer">¿Estás probando con datos de prueba de Fourvenues?</summary>
          <div className="mt-3 flex gap-2">
            {(["PRODUCTION", "ALPHA"] as const).map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => setEnvironment(env)}
                className={`nl-btn ${environment === env ? "nl-btn--quiet" : "nl-btn--ghost"}`}
              >
                {env === "PRODUCTION" ? "Producción" : "Pruebas"}
              </button>
            ))}
          </div>
        </details>

        {error ? <p className="nl-error">{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={apiKey.trim().length < 8} className="nl-btn nl-btn--hot">
            Conectar Fourvenues
          </button>
          {connected ? (
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setApiKey("");
              }}
              className="nl-btn nl-btn--ghost"
            >
              Cancelar
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
