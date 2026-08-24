import Link from "next/link";
import type { ReactNode } from "react";
import { AppNav, type NavItem } from "@/components/app-nav";
import type { UserMenuProps } from "@/components/user-menu";
import { Icon } from "@/components/ui";
import { ToastProvider } from "@/components/toast";

/**
 * Shell del panel.
 *
 * Barra inferior en móvil, lateral en escritorio, mismo componente. El
 * promoter va a vivir en el móvil y el club alternará: una navegación que
 * cambia de sitio pero no de contenido evita mantener dos árboles.
 */

export type { NavItem };

export function AppShell({
  items,
  children,
  brand,
  user,
}: {
  items: NavItem[];
  children: ReactNode;
  brand: string;
  user: UserMenuProps;
}) {
  return (
    <ToastProvider>
      <div className="nl-app">
        <AppNav items={items} brand={brand} user={user} />
        <div className="nl-shell">{children}</div>
      </div>
    </ToastProvider>
  );
}

/**
 * Volver (§29).
 *
 * En toda pantalla secundaria. Depender solo del botón del navegador falla en
 * el caso más común de este producto: alguien que abrió el link desde
 * Instagram y no tiene historial al que volver.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="nl-back">
      <Icon name="back" size={18} />
      {label}
    </Link>
  );
}

/** Migas (§30). Solo escritorio: en móvil ya está el botón de volver. */
export function Breadcrumbs({
  trail,
}: {
  trail: { label: string; href?: string }[];
}) {
  return (
    <nav className="nl-crumbs" aria-label="Ruta de navegación">
      {trail.map((crumb, i) => (
        <span key={`${crumb.label}-${i}`} className="flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          {crumb.href ? (
            <Link href={crumb.href}>{crumb.label}</Link>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Cabecera de página. El eyebrow encima del título da contexto sin migas de
 * pan, que en móvil solo ocupan sitio.
 */
export function PageHeader({
  eyebrow,
  title,
  action,
  back,
  crumbs,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  back?: { href: string; label: string };
  crumbs?: { label: string; href?: string }[];
}) {
  return (
    <header className="nl-enter mb-7">
      {back || crumbs ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          {back ? <BackLink href={back.href} label={back.label} /> : <span />}
          {crumbs ? <Breadcrumbs trail={crumbs} /> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <p className="nl-eyebrow">{eyebrow}</p> : null}
          <h1 className="nl-display nl-h2 mt-1.5">{title}</h1>
        </div>
        {action}
      </div>
    </header>
  );
}

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className={`mx-auto w-full px-5 py-8 sm:px-8 sm:py-12 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
      {children}
    </main>
  );
}
