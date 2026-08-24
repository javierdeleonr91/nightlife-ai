-- Eventos descubiertos desde el enlace público de Fourvenues del RRPP.
-- Son propiedad exclusiva del promoter y no modifican el catálogo del club.

CREATE TABLE IF NOT EXISTS promoter_fourvenues_events (
  id           text PRIMARY KEY,
  "promoterId" text NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  "sourceUrl"  text NOT NULL,
  "checkoutUrl" text NOT NULL,
  name         text NOT NULL,
  "startsAt"   timestamptz NOT NULL,
  "venueName" text,
  "imageUrl" text,
  "djLineup" text[] NOT NULL DEFAULT '{}',
  "currentPriceCents" integer,
  "soldOut" boolean NOT NULL DEFAULT false,
  "isActive" boolean NOT NULL DEFAULT true,
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promoter_fourvenues_events_promoter_source_key
  ON promoter_fourvenues_events ("promoterId", "sourceUrl");

CREATE INDEX IF NOT EXISTS promoter_fourvenues_events_promoter_starts_idx
  ON promoter_fourvenues_events ("promoterId", "startsAt");

CREATE INDEX IF NOT EXISTS promoter_fourvenues_events_active_starts_idx
  ON promoter_fourvenues_events ("promoterId", "isActive", "startsAt");
ALTER TABLE promoter_fourvenues_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE promoter_fourvenues_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON promoter_fourvenues_events;

CREATE POLICY tenant_isolation ON promoter_fourvenues_events
  TO nl_app
  USING ("promoterId" = current_setting('app.current_promoter_id', true))
  WITH CHECK ("promoterId" = current_setting('app.current_promoter_id', true));

REVOKE ALL PRIVILEGES ON public.promoter_fourvenues_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promoter_fourvenues_events TO nl_app;
REVOKE ALL PRIVILEGES ON public.promoter_fourvenues_events FROM anon;
REVOKE ALL PRIVILEGES ON public.promoter_fourvenues_events FROM authenticated;
