export default function DashboardLoading() {
  return (
    <div className="grid min-h-[50vh] place-items-center" aria-live="polite" aria-busy="true">
      <div className="nl-muted flex items-center gap-3">
        <span className="nl-spinner" />
        <span>Cargando…</span>
      </div>
    </div>
  );
}
