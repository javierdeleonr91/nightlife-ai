/**
 * «Complete your profile» (§21).
 *
 * El porcentaje se calcula **de los datos reales**, no de `onboardingStep`.
 * Esa distinción importa: alguien puede terminar el onboarding saltándose la
 * foto, o borrar su bio seis meses después. Un contador que dependiera del
 * paso del onboarding diría 100% en los dos casos y estaría mintiendo.
 *
 * `onboardingStep` solo sirve para saber dónde retomar el asistente inicial.
 *
 * Sin gamificar: ni medallas, ni rachas, ni confeti. Es una lista de lo que
 * falta con el enlace para hacerlo, y desaparece cuando está completa.
 */

export interface CompletionTask {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly done: boolean;
  /** Las esenciales pesan el doble: sin ellas el perfil no funciona. */
  readonly weight: number;
}

export interface CompletionReport {
  readonly percent: number;
  readonly tasks: readonly CompletionTask[];
  readonly pending: readonly CompletionTask[];
  readonly complete: boolean;
}

function report(tasks: CompletionTask[]): CompletionReport {
  const total = tasks.reduce((sum, t) => sum + t.weight, 0);
  const earned = tasks.filter((t) => t.done).reduce((sum, t) => sum + t.weight, 0);
  const percent = total === 0 ? 100 : Math.round((earned / total) * 100);
  const pending = tasks.filter((t) => !t.done);
  return { percent, tasks, pending, complete: pending.length === 0 };
}

function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function promoterCompletion(input: {
  photoUrl?: string | null;
  coverImageUrl?: string | null;
  bio?: string | null;
  city?: string | null;
  instagram?: string | null;
  fourvenuesUrl?: string | null;
  approvedClubCount: number;
  selectedEventCount: number;
}): CompletionReport {
  return report([
    {
      id: "photo",
      label: "Add a profile photo",
      href: "/promoter/profile",
      done: filled(input.photoUrl),
      weight: 2,
    },
    {
      id: "bio",
      label: "Write a short bio",
      href: "/promoter/profile",
      done: filled(input.bio),
      weight: 1,
    },
    {
      id: "cover",
      label: "Add a cover image",
      href: "/promoter/profile",
      done: filled(input.coverImageUrl),
      weight: 1,
    },
    {
      id: "city",
      label: "Set your city",
      href: "/promoter/profile",
      done: filled(input.city),
      weight: 1,
    },
    {
      id: "instagram",
      label: "Link your Instagram",
      href: "/promoter/profile",
      done: filled(input.instagram),
      weight: 1,
    },
    {
      id: "fourvenues",
      label: "Add your Fourvenues sales link",
      href: "/promoter/integrations",
      done: filled(input.fourvenuesUrl),
      weight: 2,
    },
    {
      id: "club",
      label: "Join a club",
      href: "/promoter/clubs",
      done: input.approvedClubCount > 0,
      weight: 2,
    },
    {
      id: "events",
      label: "Choose the events you promote",
      href: "/promoter/events",
      done: input.selectedEventCount > 0,
      weight: 1,
    },
  ]);
}

export function clubCompletion(input: {
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  description?: string | null;
  address?: string | null;
  instagram?: string | null;
  fourvenuesConnected: boolean;
  eventCount: number;
  promoterCount: number;
}): CompletionReport {
  return report([
    {
      id: "logo",
      label: "Add your logo",
      href: "branding",
      done: filled(input.logoUrl),
      weight: 2,
    },
    {
      id: "cover",
      label: "Add a cover image",
      href: "branding",
      done: filled(input.coverImageUrl),
      weight: 1,
    },
    {
      id: "description",
      label: "Describe your club",
      href: "profile",
      done: filled(input.description),
      weight: 1,
    },
    {
      id: "address",
      label: "Add your address",
      href: "profile",
      done: filled(input.address),
      weight: 1,
    },
    {
      id: "instagram",
      label: "Link your Instagram",
      href: "profile",
      done: filled(input.instagram),
      weight: 1,
    },
    {
      id: "fourvenues",
      label: "Connect Fourvenues",
      href: "integrations",
      done: input.fourvenuesConnected,
      weight: 3,
    },
    {
      id: "events",
      label: "Sync your events",
      href: "events",
      done: input.eventCount > 0,
      weight: 2,
    },
    {
      id: "promoters",
      label: "Approve your promoters",
      href: "promoters",
      done: input.promoterCount > 0,
      weight: 1,
    },
  ]);
}
