-- Segunda barrera de aislamiento: Row Level Security en Postgres.
--
-- La primera barrera es la capa de repositorios (forTenant), que hace
-- imposible escribir una consulta sin filtro. Esta es redundante a propósito:
-- un bug en la capa de aplicación no debería poder filtrar datos entre clubs.
--
-- Aplicar después de `prisma migrate deploy`:
--   psql "$DATABASE_URL" -f prisma/rls.sql
--
-- La aplicación debe conectarse con un rol SIN BYPASSRLS y fijar el club en
-- cada transacción:
--   SET LOCAL app.current_club_id = '<clubId>';

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'events', 'event_sources', 'ticket_types', 'ticket_prices', 'data_points',
    'vip_options', 'faqs', 'knowledge_items', 'customers', 'conversations',
    'messages', 'channels', 'follow_ups', 'sales', 'promoter_events',
    'promoter_clubs', 'club_members', 'brand_settings', 'ai_configs',
    'ai_request_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("clubId" = current_setting('app.current_club_id', true))
        WITH CHECK ("clubId" = current_setting('app.current_club_id', true))
    $f$, t);
  END LOOP;
END $$;

-- Nota: las tablas sin clubId (users, promoters, plans, subscriptions,
-- audit_logs) quedan fuera a propósito. users y promoters son entidades
-- globales —una persona puede trabajar para varios clubs— y su acceso lo
-- controla RBAC en la aplicación. audit_logs debe poder escribirse aunque
-- todavía no haya club en contexto.
