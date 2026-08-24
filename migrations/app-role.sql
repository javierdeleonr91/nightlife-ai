-- ════════════════════════════════════════════════════════════════════
-- app-role.sql — el rol con el que se conecta la aplicación
--
-- Se ejecuta ENTRE 001-channel-owner.sql y rls-owner.sql: las políticas
-- llevan `TO nl_app`, así que el rol tiene que existir antes.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--        -v nl_app_password="$(openssl rand -base64 32)" \
--        -f prisma/migrations/manual/app-role.sql
--
-- La contraseña se pasa como variable de psql. NO está en este archivo, no
-- se genera aquí y no se imprime: si estuviera escrita, estaría en el
-- repositorio, y una contraseña en el repositorio es una contraseña
-- comprometida. Guardarla en el gestor de secretos y ponerla en
-- DATABASE_URL.
--
-- Reejecutable: si el rol ya existe, solo se actualizan sus atributos y sus
-- permisos. Se puede volver a lanzar para rotar la contraseña.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- ── 0. La contraseña tiene que venir de fuera ───────────────────────
-- `\if :{?var}` es la forma de psql de preguntar «¿está definida?». Si no
-- lo está, paramos aquí: sin esto la variable se expandiría al literal
-- `:'nl_app_password'` y eso se convertiría en la contraseña real.
\if :{?nl_app_password}
\else
\echo 'ERROR: falta la contraseña. Vuelve a lanzarlo así:'
\echo '  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \\'
\echo '       -v nl_app_password="$(openssl rand -base64 32)" \\'
\echo '       -f prisma/migrations/manual/app-role.sql'
\quit 1
\endif

BEGIN;

-- ── 1. El rol ───────────────────────────────────────────────────────
-- Supabase hosted no entrega un superusuario PostgreSQL real. Por eso NO
-- intentamos ejecutar ALTER ROLE ... NOSUPERUSER/NOBYPASSRLS/etc.
--
-- Al crear un rol nuevo PostgreSQL ya usa por defecto:
--   NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS.
-- NOINHERIT sí se declara expresamente.
--
-- Si el rol ya existe, primero comprobamos que no tenga ningún atributo
-- privilegiado. Si lo tiene, abortamos: nunca intentamos "arreglarlo"
-- silenciosamente con operaciones reservadas a superusuario.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nl_app') THEN
    CREATE ROLE nl_app LOGIN NOINHERIT;
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  SELECT
    rolsuper,
    rolbypassrls,
    rolcreatedb,
    rolcreaterole,
    rolreplication
  INTO r
  FROM pg_roles
  WHERE rolname = 'nl_app';

  IF r.rolsuper
     OR r.rolbypassrls
     OR r.rolcreatedb
     OR r.rolcreaterole
     OR r.rolreplication THEN
    RAISE EXCEPTION
      'nl_app tiene atributos privilegiados. Debe ser NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE y NOREPLICATION.';
  END IF;
END $$;

-- Estas propiedades sí se pueden mantener para un rol ordinario sin intentar
-- modificar atributos reservados a un superusuario.
-- También permite rotar la contraseña al volver a ejecutar este archivo.
ALTER ROLE nl_app
  LOGIN
  NOINHERIT
  PASSWORD :'nl_app_password';

-- Comprobación final del estado que necesita la aplicación.
DO $$
DECLARE
  r record;
BEGIN
  SELECT
    rolcanlogin,
    rolinherit,
    rolsuper,
    rolbypassrls,
    rolcreatedb,
    rolcreaterole,
    rolreplication
  INTO r
  FROM pg_roles
  WHERE rolname = 'nl_app';

  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'nl_app no tiene LOGIN.';
  END IF;

  IF r.rolinherit THEN
    RAISE EXCEPTION 'nl_app tiene INHERIT y debe usar NOINHERIT.';
  END IF;

  IF r.rolsuper
     OR r.rolbypassrls
     OR r.rolcreatedb
     OR r.rolcreaterole
     OR r.rolreplication THEN
    RAISE EXCEPTION 'nl_app tiene atributos privilegiados inseguros.';
  END IF;

  RAISE NOTICE 'nl_app verificado: LOGIN, NOINHERIT y sin atributos privilegiados';
END $$;

-- ── 2. Permisos: solo lo que la aplicación usa ──────────────────────
-- Nada de GRANT ... ON ALL TABLES ni ALTER DEFAULT PRIVILEGES globales. Una
-- tabla nueva no debe volverse accesible por existir: hay que añadirla aquí
-- a mano, y ese trámite es la revisión.

GRANT USAGE ON SCHEMA public TO nl_app;

DO $$
DECLARE
  t text;
  -- Las seis polimórficas más las de club que la aplicación consulta.
  -- Cada una está aquí porque hay código que la usa; si dejas de usarla,
  -- quítala.
  rw text[] := ARRAY[
    -- Polimórficas (dueño club o promoter)
    'channels', 'customers', 'conversations', 'messages',
    'follow_ups', 'ai_request_logs',
    -- De club
    'events', 'event_sources', 'ticket_types', 'ticket_prices', 'data_points',
    'vip_options', 'faqs', 'knowledge_items', 'sales', 'promoter_events',
    'promoter_clubs', 'club_members', 'brand_settings', 'ai_configs',
    'clubs', 'promoters', 'users', 'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY rw LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO nl_app', t);
    END IF;
  END LOOP;
END $$;

-- Secuencias: solo las de las tablas de arriba que las tengan. El esquema
-- usa ids de texto (cuid), así que hoy no hay ninguna; el bucle está para
-- que si algún día aparece una, se conceda esa y no todas.
DO $$
DECLARE s record;
BEGIN
  FOR s IN
    SELECT c.oid::regclass AS seq
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND n.nspname = 'public'
       AND EXISTS (
         SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
          WHERE d.objid = c.oid AND t.relname IN (
            'channels','customers','conversations','messages',
            'follow_ups','ai_request_logs'))
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO nl_app', s.seq);
  END LOOP;
END $$;

-- ── 3. Quitarle a los demás lo que no necesitan ─────────────────────
-- Las seis tablas polimórficas son internas: solo las toca Prisma desde el
-- servidor. `anon` y `authenticated` son los roles de PostgREST (la API
-- automática de Supabase); si tienen CRUD sobre estas tablas, cualquiera
-- con la anon key puede consultarlas por HTTP sin pasar por nuestro código.
--
-- Solo se tocan estas seis. Auth, Storage y el resto del esquema de
-- Supabase se quedan como están: no son de esta migración.
DO $$
DECLARE
  r text; t text;
  internas text[] := ARRAY['channels','customers','conversations','messages',
                           'follow_ups','ai_request_logs'];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY internas LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name=t) THEN
          EXECUTE format(
            'REVOKE ALL PRIVILEGES ON public.%I FROM %I', t, r);
        END IF;
      END LOOP;
      RAISE NOTICE 'Revocado CRUD de % sobre las 6 tablas internas', r;
    END IF;
  END LOOP;
END $$;

-- PUBLIC tampoco. Un GRANT a PUBLIC alcanza a todo rol presente y futuro.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','customers','conversations','messages',
                           'follow_ups','ai_request_logs'] LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM PUBLIC', t);
  END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Después de esto:
--
--   DATABASE_URL → nl_app     (la aplicación; las políticas se le aplican)
--   DIRECT_URL   → el rol de migraciones (sin políticas, a propósito)
--
-- `verification.sql` comprueba los atributos REALES del rol leyendo
-- pg_roles, y aborta si `nl_app` resulta ser superusuario o tener
-- BYPASSRLS. No da por supuesto qué es cada rol en tu instalación.
-- ════════════════════════════════════════════════════════════════════
