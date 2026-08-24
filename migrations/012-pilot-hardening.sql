\set ON_ERROR_STOP on

BEGIN;

-- 012 · Hardening para piloto
-- Reduce los permisos temporales amplios de nl_app y extiende RLS
-- a las tablas inequívocamente pertenecientes a un Club.

-- ── 1. Comprobar el rol ──────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  SELECT
    rolcanlogin,
    rolsuper,
    rolbypassrls,
    rolcreatedb,
    rolcreaterole,
    rolreplication
  INTO r
  FROM pg_roles
  WHERE rolname = 'nl_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe nl_app';
  END IF;

  IF NOT r.rolcanlogin
     OR r.rolsuper
     OR r.rolbypassrls
     OR r.rolcreatedb
     OR r.rolcreaterole
     OR r.rolreplication THEN
    RAISE EXCEPTION 'nl_app tiene atributos incompatibles con RLS';
  END IF;
END $$;


-- ── 2. RLS para tablas propiedad de un Club ──────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_configs',
    'audit_logs',
    'brand_settings',
    'club_integrations',
    'data_points',
    'event_sources',
    'events',
    'faqs',
    'knowledge_items',
    'ticket_prices',
    'ticket_types',
    'vip_options'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      t
    );

    EXECUTE format(
      'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
      t
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON public.%I',
      t
    );

    EXECUTE format(
      'CREATE POLICY tenant_isolation
         ON public.%I
         FOR ALL
         TO nl_app
         USING (
           "clubId" = current_setting(''app.current_club_id'', true)
         )
         WITH CHECK (
           "clubId" = current_setting(''app.current_club_id'', true)
         )',
      t
    );
  END LOOP;
END $$;


-- ── 3. Quitar el GRANT temporal de desarrollo ────────────────

REVOKE ALL PRIVILEGES
ON ALL TABLES IN SCHEMA public
FROM nl_app;


-- ── 4. Tablas protegidas por RLS ─────────────────────────────
-- Aquí el CRUD queda además limitado por la política del tenant.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_configs',
    'ai_request_logs',
    'beta_feedback',
    'brand_settings',
    'channels',
    'club_integrations',
    'conversations',
    'customers',
    'data_points',
    'event_sources',
    'events',
    'faqs',
    'follow_ups',
    'knowledge_items',
    'messages',
    'promoter_clubs',
    'promoter_events',
    'promoter_faqs',
    'promoter_knowledge',
    'ticket_prices',
    'ticket_types',
    'unanswered_questions',
    'vip_options'
  ]
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO nl_app',
      t
    );
  END LOOP;
END $$;


-- ── 5. Entidades globales de bootstrap/auth ──────────────────
-- Se necesitan antes de poder resolver qué tenant corresponde.
-- No se concede DELETE.

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.clubs,
  public.promoters,
  public.users,
  public.user_identities,
  public.club_invites,
  public.subscriptions
TO nl_app;


-- Los planes comerciales son catálogo para la aplicación.
-- Las altas/actualizaciones pertenecen a seed/migraciones.
GRANT SELECT
ON TABLE public.plans
TO nl_app;


-- Runtime solo genera y, si hace falta, devuelve el audit recién insertado.
-- No puede editar ni borrar el historial.
GRANT SELECT, INSERT
ON TABLE public.audit_logs
TO nl_app;


-- Las membresías se leen al construir el Principal y se crean
-- durante el onboarding. Runtime no necesita UPDATE ni DELETE.

GRANT SELECT, INSERT
ON TABLE public.club_members
TO nl_app;


-- ── 6. Cerrar acceso directo desde PostgREST a tablas internas ─

DO $$
DECLARE
  role_name text;
  t text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = role_name
    ) THEN
      FOREACH t IN ARRAY ARRAY[
        'ai_configs',
        'ai_request_logs',
        'audit_logs',
        'beta_feedback',
        'channels',
        'club_integrations',
        'conversations',
        'customers',
        'data_points',
        'event_sources',
        'follow_ups',
        'messages',
        'promoter_clubs',
        'promoter_events',
        'promoter_faqs',
        'promoter_knowledge',
        'unanswered_questions'
      ]
      LOOP
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          t,
          role_name
        );
      END LOOP;
    END IF;
  END LOOP;
END $$;


COMMIT;
