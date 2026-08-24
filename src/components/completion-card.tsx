import Link from "next/link";
import { CheckMark } from "@/components/ui";
import type { CompletionReport } from "@nightlife/core/completion";

/**
 * «Complete your profile» (§21).
 *
 * Sin gamificar: ni medallas, ni rachas, ni confeti. Una barra, un porcentaje y
 * la lista de lo que falta con su enlace. Cuando está al 100% la tarjeta
 * desaparece — un panel que sigue felicitándote por algo que ya hiciste es
 * ruido permanente.
 *
 * El porcentaje sale de los datos reales, no del paso del onboarding: si
 * alguien borra su bio seis meses después, el porcentaje baja.
 */
export function CompletionCard({
  report,
  title = "Completa tu perfil",
  hrefPrefix = "",
}: {
  report: CompletionReport;
  title?: string;
  /** Los enlaces del club son relativos a /club/{slug}/. */
  hrefPrefix?: string;
}) {
  if (report.complete) return null;

  return (
    <section className="nl-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="nl-display text-[1.15rem]">{title}</p>
        <span className="nl-price nl-price--md">{report.percent}%</span>
      </div>

      <div className="nl-meter mt-3" role="img" aria-label={`${report.percent}% complete`}>
        <span className="nl-meter__fill" style={{ width: `${report.percent}%` }} />
      </div>

      <ul className="mt-3">
        {report.pending.slice(0, 4).map((task) => (
          <li key={task.id}>
            <Link href={`${hrefPrefix}${task.href}`} className="nl-todo">
              <span className="nl-todo__box" aria-hidden="true" />
              {task.label}
            </Link>
          </li>
        ))}
      </ul>

      {report.tasks.some((t) => t.done) ? (
        <p className="nl-dim mt-2 flex items-center gap-1.5 text-[0.8125rem]">
          <span style={{ color: "var(--nl-live)" }}>
            <CheckMark size={13} />
          </span>
          {report.tasks.filter((t) => t.done).length} of {report.tasks.length} done
        </p>
      ) : null}
    </section>
  );
}
