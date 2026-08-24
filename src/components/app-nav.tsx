"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui";
import { UserMenu, type UserMenuProps } from "@/components/user-menu";

/**
 * Navegación del panel.
 *
 * El club tiene ocho destinos y el promoter seis (§25, §26). Ocho no caben en
 * una barra inferior: con más de cuatro dejan de poder tocarse con el pulgar.
 * Solución: los tres primeros más «More», que abre una hoja con el resto. En
 * escritorio la barra lateral los enseña todos y la hoja no existe.
 *
 * Es el único trozo del shell que necesita saber dónde estás, así que es el
 * único que se envía al navegador.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
  /** Fuera de la barra inferior: solo en la hoja «More» y en la lateral. */
  secondary?: boolean;
}

export function AppNav({
  items,
  brand,
  user,
}: {
  items: NavItem[];
  brand: string;
  user: UserMenuProps;
}) {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const primary = items.filter((i) => !i.secondary);
  const secondary = items.filter((i) => i.secondary);
  const sheetHasActive = secondary.some((i) => isActive(i.href));

  return (
    <>
      <nav className="nl-nav" aria-label="Navegación principal">
        <p className="nl-display mb-6 hidden truncate px-3 text-[1.05rem] lg:block">{brand}</p>

        {/* En móvil solo los primarios; en escritorio, todos. */}
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`nl-nav__item ${item.secondary ? "hidden lg:flex" : ""}`}
            {...(isActive(item.href) ? { "aria-current": "page" as const } : {})}
          >
            <span className="relative">
              <Icon name={item.icon} size={21} />
              {item.badge && item.badge > 0 ? (
                <span
                  className="absolute -right-1.5 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-full px-1 text-[9px] font-bold"
                  style={{ background: "var(--nl-crit)", color: "var(--nl-void)" }}
                >
                  {item.badge > 9 ? "9+" : item.badge}
                  <span className="nl-sr"> conversaciones esperando atención</span>
                </span>
              ) : null}
            </span>
            {item.label}
          </Link>
        ))}

        {secondary.length > 0 ? (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="nl-nav__item lg:hidden"
            aria-haspopup="dialog"
            {...(sheetHasActive ? { "aria-current": "page" as const } : {})}
          >
            <Icon name="more" size={21} />
            Más
          </button>
        ) : null}

        {/* El menú de usuario vive al final de la lateral y arriba de la hoja. */}
        <div className="mt-auto hidden lg:block">
          <UserMenu {...user} />
        </div>
      </nav>

      {sheetOpen ? (
        <div
          className="nl-scrim lg:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div className="nl-sheet" role="dialog" aria-modal="true" aria-label="Más opciones">
            <div className="nl-modal__grab" />

            <div className="px-3 py-4">
              <UserMenu {...user} />
            </div>

            {secondary.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="nl-sheet__item"
                onClick={() => setSheetOpen(false)}
                {...(isActive(item.href) ? { "aria-current": "page" as const } : {})}
              >
                <Icon name={item.icon} size={21} />
                {item.label}
              </Link>
            ))}

            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              className="nl-btn nl-btn--ghost nl-btn--block mt-2"
            >
              Cerrar
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
