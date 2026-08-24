import { redirect } from "next/navigation";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { getPrincipal } from "@/lib/session";
import { ButtonLink } from "@/components/ui";

/**
 * Raíz. No es una landing de marketing: reparte a la gente hacia donde
 * trabaja. Un club entra a su panel, un promoter al suyo. Solo quien no ha
 * entrado nunca ve esta pantalla, y para esa persona lo único que importa es
 * entender en tres segundos qué es esto y empezar.
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
    <div className="nl-app grid min-h-dvh place-items-center px-6 py-12">
      <div className="nl-enter w-full max-w-lg">
        <p className="nl-eyebrow">Nightlife Automatico</p>

        <h1 className="nl-display nl-h1 mt-4">
          Tu equipo vende.
          <br />
          <span style={{ color: "var(--nl-hot)" }}>La IA responde.</span>
        </h1>

        <p className="nl-muted mt-5 max-w-[42ch] text-[1.0625rem]">
          Responde las preguntas de siempre con el precio real de ahora mismo y lleva al cliente al
          checkout de tu ticketera. Sin cambiar de ticketera.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/register" variant="hot" size="lg">
            Empezar
          </ButtonLink>
          <ButtonLink href="/login" variant="quiet" size="lg">
            Entrar
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
