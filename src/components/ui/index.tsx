import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Primitivas del design system.
 *
 * Componentes de servidor por defecto: nada de esto necesita estado, así que
 * nada de esto debe viajar al navegador. Solo los que de verdad interactúan
 * (modal, import, share) llevan "use client". La página pública tiene que
 * cargar rápido en el móvil de alguien con mala cobertura a las dos de la
 * mañana, y el JavaScript que no se envía es el más rápido de todos.
 */

type Tone = "neutral" | "live" | "hot" | "warn" | "crit" | "violet";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "",
  live: "nl-badge--live",
  hot: "nl-badge--hot",
  warn: "nl-badge--warn",
  crit: "nl-badge--crit",
  violet: "nl-badge--violet",
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
}) {
  return (
    <span className={`nl-badge ${TONE_CLASS[tone]}`}>
      {dot ? <span className={`nl-dot ${pulse ? "nl-dot--pulse" : ""}`} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

type ButtonVariant = "hot" | "quiet" | "ghost";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  hot: "nl-btn--hot",
  quiet: "nl-btn--quiet",
  ghost: "nl-btn--ghost",
};

export function ButtonLink({
  href,
  children,
  variant = "quiet",
  size,
  block = false,
  external = false,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: "lg";
  block?: boolean;
  external?: boolean;
}) {
  const className = [
    "nl-btn",
    VARIANT_CLASS[variant],
    size === "lg" ? "nl-btn--lg" : "",
    block ? "nl-btn--block" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (external) {
    return (
      <a href={href} className={className} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="nl-eyebrow">{children}</p>;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`nl-panel ${className}`}>{children}</section>;
}

/**
 * Empty state con nombre y propósito.
 *
 * "No hay eventos." no es un estado vacío, es un callejón sin salida. El
 * vacío es el momento en que más falta hace decirle a alguien qué hacer a
 * continuación, y para muchos clubs será la primera pantalla que vean.
 */
export function EmptyState({
  glyph,
  title,
  body,
  action,
}: {
  glyph: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="nl-empty nl-enter">
      <span className="nl-empty__glyph" aria-hidden="true">
        {glyph}
      </span>
      <div className="grid gap-2">
        <h3 className="nl-h3">{title}</h3>
        <p className="nl-muted mx-auto max-w-[38ch] text-balance">{body}</p>
      </div>
      {action}
    </div>
  );
}

/** Cifra grande con etiqueta. Estado, no analítica. */
export function StatTile({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: Tone;
  hint?: string;
}) {
  const color =
    tone === "live"
      ? "var(--nl-live)"
      : tone === "warn"
        ? "var(--nl-warn)"
        : tone === "crit"
          ? "var(--nl-crit)"
          : "var(--nl-text)";
  return (
    <div className="nl-card nl-card--flat p-4">
      <p className="nl-eyebrow">{label}</p>
      <p className="nl-display mt-1.5 text-[1.6rem]" style={{ color }}>
        {value}
      </p>
      {hint ? <p className="nl-dim mt-0.5 text-[0.8125rem]">{hint}</p> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`nl-skeleton ${className}`} aria-hidden="true" />;
}

export function CheckMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="nl-check"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 12.5 10 17.5 19 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Iconos propios: 12 líneas de SVG frente a una librería de iconos entera. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export type IconName =
  | "home"
  | "calendar"
  | "chat"
  | "link"
  | "settings"
  | "plus"
  | "bolt"
  | "refresh"
  | "arrow"
  | "back"
  | "share"
  | "ticket"
  | "more"
  | "exit"
  | "plug"
  | "users"
  | "palette"
  | "card"
  | "crown"
  | "close"
  | "chevron"
  | "camera"
  | "eye"
  | "copy"
  | "shield";

const ICON_PATHS: Record<IconName, ReactNode> = {
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  camera: (
    <>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2a2 2 0 0 0 1.7-.95l.6-1a1 1 0 0 1 .85-.5h2.3a1 1 0 0 1 .86.5l.6 1A2 2 0 0 0 16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
    </>
  ),
  shield: <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />,
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  chat: <path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />,
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 4.34l-1.5 1.5" />
      <path d="M14 11a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 19.66l1.5-1.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-2.73 1.13V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.4 19.4l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.6 1.13l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 20.4 10H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  back: <path d="M19 12H5m6 6-6-6 6-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  exit: (
    <>
      <path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 18v3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6M17.5 20a6 6 0 0 0-2.2-4.6" />
    </>
  ),
  palette: (
    <>
      <path d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21z" />
      <circle cx="7.5" cy="12" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="15" cy="8.5" r="1" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M2.5 10h19" />
    </>
  ),
  crown: <path d="M4 18h16M4 18 3 8l5 3.5L12 5l4 6.5L21 8l-1 10z" />,
  share: (
    <>
      <path d="M12 3v13" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  ticket: (
    <>
      <path d="M3 9a2 2 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 0 1 0-6V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
      <path d="M15 4v16" strokeDasharray="2 3" />
    </>
  ),
};
