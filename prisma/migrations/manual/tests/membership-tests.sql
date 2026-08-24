-- ════════════════════════════════════════════════════════════════════
-- Las tablas de pertenencia, como nl_app
--
-- Prueba lo que arregla la migración 011 y, sobre todo, que el arreglo NO
-- abre nada: Liberata sigue sin ver los RRPPs de MON.
--
--   psql -d migtest -U nl_app -v ON_ERROR_STOP=1 -f tests/membership-tests.sql
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE TEMP TABLE _m (caso text, detalle text);

-- ── 1. loadPrincipal: sin contexto, porque todavía no se sabe cuál ──
-- Es la consulta que hace la aplicación nada más iniciar sesión, antes de
-- saber a qué club pertenece nadie. Con la política circular original
-- devolvía cero y el usuario entraba sin pertenecer a nada.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM club_members WHERE "userId" = 'user_javi';
  IF n = 1 THEN RAISE NOTICE 'OK     · 1a club_members se lee sin contexto (login posible)';
  ELSE INSERT INTO _m VALUES ('1a', format('%s filas, esperaba 1 — nadie podría iniciar sesión', n)); END IF;

  -- ── 1b · La otra mitad del login, que app-06 descubrió ────────────
  -- `promoter_clubs` NO sale de RLS: 011 le da política de dos caras, y eso
  -- es lo correcto. Pero significa que sin contexto tampoco se ve, y
  -- `loadPrincipal` la leía como relación anidada desde `users` —que no
  -- tiene políticas— justo en el instante en que no hay nada fijado.
  --
  -- No rompe el login: el RRPP entra. Entra con `promoterClubIds` vacío y
  -- se encuentra el panel diciéndole que no trabaja con ningún club. Por eso
  -- desde app-06 esa lectura va aparte, en contexto del propio RRPP (caso 2a).
  SELECT count(*) INTO n FROM promoter_clubs WHERE "promoterId" = 'prom_javi';
  IF n = 0 THEN RAISE NOTICE 'OK     · 1b promoter_clubs SÍ se filtra sin contexto → no puede ir en el include del login';
  ELSE INSERT INTO _m VALUES ('1b', format('%s filas sin contexto, esperaba 0 — ¿se le quitó RLS a promoter_clubs?', n)); END IF;
END $$;

-- ── 2. El RRPP ve sus clubs sin fijar ninguno ───────────────────────
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM promoter_clubs WHERE "promoterId" = 'prom_javi';
  IF n = 2 THEN RAISE NOTICE 'OK     · 2a el RRPP ve sus 2 clubs sin fijar ninguno';
  ELSE INSERT INTO _m VALUES ('2a', format('el RRPP ve %s clubs, esperaba 2', n)); END IF;

  SELECT count(*) INTO n FROM promoter_events WHERE "promoterId" = 'prom_javi';
  IF n = 1 THEN RAISE NOTICE 'OK     · 2b y sus eventos';
  ELSE INSERT INTO _m VALUES ('2b', format('%s eventos, esperaba 1', n)); END IF;
END $$;
COMMIT;

-- ── 3. El club ve sus RRPPs ─────────────────────────────────────────
BEGIN;
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM promoter_clubs;
  IF n = 1 THEN RAISE NOTICE 'OK     · 3 MON ve su RRPP';
  ELSE INSERT INTO _m VALUES ('3', format('MON ve %s filas, esperaba 1', n)); END IF;
END $$;
COMMIT;

-- ── 4. Lo que importa: sigue aislado ────────────────────────────────
BEGIN;
SELECT set_config('app.current_club_id', 'club_lib', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM promoter_clubs WHERE "clubId" = 'club_mon';
  IF n = 0 THEN RAISE NOTICE 'OK     · 4a Liberata NO ve los RRPPs de MON';
  ELSE INSERT INTO _m VALUES ('4a', format('FUGA: Liberata ve %s filas de MON', n)); END IF;

  SELECT count(*) INTO n FROM promoter_events WHERE "clubId" = 'club_mon';
  IF n = 0 THEN RAISE NOTICE 'OK     · 4b ni sus eventos de RRPP';
  ELSE INSERT INTO _m VALUES ('4b', format('FUGA: Liberata ve %s eventos de MON', n)); END IF;
END $$;
COMMIT;

-- ── 5. Un RRPP tampoco puede darse de alta en un club a lo bruto ────
-- El WITH CHECK acepta por el lado del promoter, que es como la aplicación
-- crea una solicitud PENDING. Lo que no puede es crearla a nombre de otro.
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO promoter_clubs (id,"clubId","promoterId",status)
    VALUES ('pc_intruso','club_mon','tt_no_existe','PENDING');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'OK     · 5 no puede darse de alta a nombre de otro RRPP';
  ELSE INSERT INTO _m VALUES ('5', 'un RRPP creó una solicitud a nombre de otro'); END IF;
END $$;
ROLLBACK;

DO $$
DECLARE n int; det text;
BEGIN
  SELECT count(*), string_agg(caso||': '||detalle, ' | ') INTO n, det FROM _m;
  IF n = 0 THEN RAISE NOTICE 'membership-tests: TODO VERDE.';
  ELSE RAISE EXCEPTION 'membership-tests: % casos fallidos → %', n, det;
  END IF;
END $$;
