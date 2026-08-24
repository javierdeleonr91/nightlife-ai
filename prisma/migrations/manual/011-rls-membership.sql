-- ════════════════════════════════════════════════════════════════════
-- 011 · Las tablas de pertenencia
--
-- ESTO ES UN BLOQUEANTE PARA CAMBIAR DATABASE_URL A nl_app. No cambia
-- ninguna tabla ni ningún dato: solo políticas de RLS. Pero sin él, con
-- `nl_app` **nadie puede iniciar sesión en ningún club**.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--        -f prisma/migrations/manual/011-rls-membership.sql
--
-- ── El problema, en concreto ────────────────────────────────────────
--
-- `rls.sql` puso la misma política en las veinte tablas de club:
--
--     USING ("clubId" = current_setting('app.current_club_id', true))
--
-- Para `events` o `faqs` es exactamente lo que se quiere. Para
-- `club_members` y `promoter_clubs` es circular, y por eso rompe:
--
--   1. Alguien inicia sesión.
--   2. `loadPrincipal()` lee `club_members` para averiguar A QUÉ CLUBS
--      pertenece.
--   3. Pero para leer `club_members` hay que tener ya fijado un club.
--   4. No hay ninguno fijado — es justo lo que se está intentando
--      averiguar.
--   5. Cero filas. Sin error. El usuario entra sin pertenecer a nada.
--
-- Son las tablas que DEFINEN quién puede actuar en nombre de qué
-- inquilino: son la entrada de la decisión de tenancy, así que no pueden
-- estar detrás de esa misma decisión.
--
-- No es una idea nueva ni una excepción incómoda: `rls.sql` ya dejó fuera
-- `users` y `promoters` por este mismo motivo, y lo dice en su nota final
-- («son entidades globales; su acceso lo controla RBAC en la aplicación»).
-- `club_members` es de esa familia y se quedó dentro por descuido.
--
-- ── Lo que hace este archivo ────────────────────────────────────────
--
--   club_members    → fuera de RLS. Es la tabla de autorización.
--   promoter_clubs  → política de DOS caras: el club ve sus RRPPs y el
--                     RRPP ve sus clubs.
--   promoter_events → igual.
--
-- Los dos últimos no salen de RLS: siguen aislados, solo que ahora
-- reconocen que tienen dos dueños legítimos —el club y el RRPP— igual que
-- las seis tablas de la migración 001.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Mismo control que en 001: si esta sesión está sujeta a RLS, no se puede
-- confiar en lo que se lea aquí.
DO $$
DECLARE filtrado boolean := false;
BEGIN
  BEGIN
    PERFORM set_config('row_security', 'off', true);
    PERFORM count(*) FROM clubs;
  EXCEPTION WHEN others THEN filtrado := true;
  END;
  PERFORM set_config('row_security', 'on', true);
  IF filtrado THEN
    RAISE EXCEPTION 'El rol % está sujeto a RLS. Usa DIRECT_URL.', current_user;
  END IF;
END $$;

-- ── 1. club_members sale de RLS ─────────────────────────────────────
-- La aplicación sigue filtrando por club en cada consulta (`forTenant`), y
-- ninguna ruta pública lee esta tabla. Lo que se pierde es una segunda
-- barrera sobre la lista de quién trabaja en qué club; lo que se gana es
-- que el inicio de sesión funcione.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='club_members') THEN
    DROP POLICY IF EXISTS tenant_isolation ON club_members;
    ALTER TABLE club_members NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE club_members DISABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'club_members: RLS desactivado (tabla de autorización)';
  END IF;
END $$;

-- ── 2. promoter_clubs y promoter_events: dos caras ──────────────────
-- Un RRPP tiene que poder listar los clubs con los que trabaja sin fijar
-- ninguno de ellos —son varios— y un club tiene que poder listar sus
-- RRPPs. Las dos cosas son legítimas y ninguna deja ver la del otro.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promoter_clubs', 'promoter_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name=t) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);

    -- El `IS NOT NULL` de cada rama no es adorno: sin él, comparar una
    -- columna nula contra la variable da NULL —ni cierto ni falso— y la
    -- fila queda invisible hasta para su dueño, sin error ninguno.
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        TO nl_app
        USING (
          ("clubId" IS NOT NULL
             AND "clubId" = current_setting('app.current_club_id', true))
          OR
          ("promoterId" IS NOT NULL
             AND "promoterId" = current_setting('app.current_promoter_id', true))
        )
        WITH CHECK (
          ("clubId" IS NOT NULL
             AND "clubId" = current_setting('app.current_club_id', true))
          OR
          ("promoterId" IS NOT NULL
             AND "promoterId" = current_setting('app.current_promoter_id', true))
        )
    $f$, t);
    RAISE NOTICE '%: política de dos caras (club o RRPP)', t;
  END LOOP;
END $$;

-- ── 3. Comprobar ────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname='club_members' AND c.relrowsecurity;
  IF n <> 0 THEN RAISE EXCEPTION 'club_members sigue con RLS activo'; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND policyname='tenant_isolation'
     AND tablename IN ('promoter_clubs','promoter_events')
     AND qual LIKE '%current_setting(''app.current_promoter_id''%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'Solo % de 2 políticas reconocen al RRPP', n;
  END IF;

  -- Y ninguna de las dos puede quedarse sin política: RLS activo sin
  -- política niega el acceso a todo el mundo devolviendo cero filas.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('promoter_clubs','promoter_events');
  IF n < 2 THEN RAISE EXCEPTION 'Falta alguna política'; END IF;

  RAISE NOTICE '011: club_members fuera de RLS, promoter_clubs y promoter_events con política de dos caras.';
END $$;

COMMIT;
