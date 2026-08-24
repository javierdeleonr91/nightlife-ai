"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";

/**
 * Zona de usuario de la barra lateral (§3, §4).
 *
 * Faltaba lo más básico: el producto no tenía **ninguna forma de cerrar
 * sesión**. El endpoint existía desde el primer día y nunca hubo un botón.
 *
 * Ahora enseña quién eres y con qué papel — «Javier De Leon / Promoter» — y
 * abre el menú con todo lo que se refiere a tu cuenta. La razón de que el
 * perfil público esté aquí arriba del todo es que es lo que más veces se
 * quiere abrir: ver cómo te ve la gente.
 *
 * Cerrar sesión de verdad son tres cosas, y ninguna sobra: invalidar la cookie
 * en el servidor, salir con una navegación dura para no arrastrar la caché del
 * router, y el middleware bloqueando cualquier ruta privada a partir de ahí.
 */

export interface UserMenuProps {
  name: string;
  email: string;
  /** «Promoter», «Owner», «Manager». Lo que eres, no lo que puedes. */
  role: string;
  avatarUrl?: string | null;
  /** Página pública real: /alex o /c/mon-madrid. */
  publicHref: string;
  profileHref: string;
  settingsHref: string;
  integrationsHref: string;
  subscriptionHref: string;
}

export function UserMenu({
  name,
  email,
  role,
  avatarUrl,
  publicHref,
  profileHref,
  settingsHref,
  integrationsHref,
  subscriptionHref,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  /**
   * Cerrar sesión de verdad.
   *
   * El menú se cierra primero: si la petición tarda, dejar el desplegable
   * abierto encima parece que no ha pasado nada.
   *
   * La salida es una navegación **dura** (`window.location.replace`) y no
   * `router.push`. Dos razones, las dos reales:
   *
   *  · el router de Next cachea las páginas de servidor ya visitadas, así que
   *    una navegación de cliente puede volver a pintar el panel con los datos
   *    de la sesión que se acaba de cerrar;
   *  · `replace` sustituye la entrada del historial, de modo que el botón
   *    «atrás» del navegador no devuelve a la pantalla anterior.
   *
   * Aunque la petición falle se sale igual: dejar a alguien dentro después de
   * pulsar «cerrar sesión» es peor que un error de red. La cookie es httpOnly,
   * así que si el servidor no la borró, el middleware seguirá dejándole entrar
   * — pero eso es un fallo del servidor, no algo que arreglemos quedándonos
   * en la pantalla.
   */
  async function logOut() {
    setBusy(true);
    setOpen(false);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST", cache: "no-store" });
    } catch {
      // Sin ruido: se sale igual.
    }
    window.location.replace("/login");
  }

  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

  const items: { href: string; label: string; icon: Parameters<typeof Icon>[0]["name"]; external?: boolean }[] = [
    { href: publicHref, label: "Ver perfil público", icon: "eye", external: true },
    { href: profileHref, label: "Editar perfil", icon: "settings" },
    { href: settingsHref, label: "Ajustes", icon: "shield" },
    { href: integrationsHref, label: "Integraciones", icon: "plug" },
    { href: subscriptionHref, label: "Plan", icon: "card" },
  ];

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="nl-user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menú de cuenta"
      >
        <span className="nl-avatar" aria-hidden="true">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- foto subida por la persona
            <img src={avatarUrl} alt="" />
          ) : (
            initials
          )}
        </span>
        <span className="nl-user-trigger__id">
          <span className="nl-user-trigger__name">{name}</span>
          <span className="nl-user-trigger__role">{role}</span>
        </span>
        <span className={`nl-user-trigger__chev ${open ? "is-open" : ""}`} aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>

      {busy ? (
        <p className="nl-dim mt-2 flex items-center gap-2 px-2 text-[0.8125rem]">
          <span className="nl-spinner" />
          Cerrando sesión…
        </p>
      ) : null}

      {open ? (
        <div className="nl-menu" role="menu">
          <div className="nl-menu__head">
            <p className="truncate font-semibold">{name}</p>
            <p className="nl-dim truncate text-[0.8125rem]">{email}</p>
          </div>

          {items.map((item) =>
            item.external ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="nl-menu__item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <Icon name={item.icon} size={17} />
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="nl-menu__item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <Icon name={item.icon} size={17} />
                {item.label}
              </Link>
            ),
          )}

          <div className="nl-menu__sep" />

          <button
            type="button"
            onClick={logOut}
            disabled={busy}
            className="nl-menu__item nl-menu__item--danger"
            role="menuitem"
          >
            {busy ? <span className="nl-spinner" /> : <Icon name="exit" size={17} />}
            {busy ? "Cerrando sesión…" : "Cerrar sesión"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
