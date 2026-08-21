import Link from "next/link";
import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { getPrincipal } from "@/lib/session";

/**
 * Raíz. No es una landing de marketing: reparte a la gente hacia donde
 * trabaja. Un club entra a su panel, un promoter al suyo.
 */
export default async function RootPage() {
  const principal = await getPrincipal();

  if (principal) {
    const firstClubId = [...principal.clubRoles.keys()][0];
    if (firstClubId) {
      const club = await prisma.club.findUnique({
        where: { id: firstClubId },
        select: { slug: true },
      });
      if (club) redirect(`/club/${club.slug}/overview`);
    }
    if (principal.promoterId) redirect("/promoter/home");
    redirect("/onboarding");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-8 px-6">
      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-dash-muted">
          Nightlife Automatico
        </p>
        <h1 className="text-4xl font-black leading-tight">
          Tu equipo vende.
          <br />
          La IA responde.
        </h1>
        <p className="text-dash-muted">
          Responde las preguntas de siempre con el precio real de ahora mismo y lleva al cliente al
          checkout de tu ticketera. Sin cambiar de ticketera.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/register"
          className="rounded-lg bg-dash-accent px-5 py-3 text-sm font-semibold text-white"
        >
          Crear cuenta
        </Link>
        <Link href="/login" className="rounded-lg border border-dash-line px-5 py-3 text-sm font-semibold">
          Entrar
        </Link>
      </div>
    </main>
  );
}
