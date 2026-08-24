-- ════════════════════════════════════════════════════════════════════
-- RLS + reutilización de conexión, ejecutado COMO nl_app
--
-- Esta es la mitad B de las pruebas. La mitad A (verification.sql) mira el
-- catálogo con un rol administrativo; esta se conecta como el rol real de
-- la aplicación y comprueba lo único que importa de verdad: quién ve qué.
--
--   psql -d migtest -U nl_app -v ON_ERROR_STOP=1 -f tests/rls-pooling-tests.sql
--
-- Todo el guion corre en UNA sola sesión de psql = UNA sola conexión
-- física. Cada BEGIN/COMMIT es una petición distinta que el pooler ha
-- mandado por esa misma conexión reutilizada. Es la única forma de
-- reproducir de verdad la contaminación entre inquilinos.
--
-- Los fallos se acumulan y al final se lanza una excepción: con
-- ON_ERROR_STOP=1, un solo fallo hace que psql salga con código != 0.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

-- ── Tabla temporal para acumular fallos entre transacciones ─────────
-- Hace falta porque el guion abre y cierra varias transacciones a
-- propósito: una variable de plpgsql no sobreviviría entre ellas. Una tabla
-- temporal muere con la sesión y no deja rastro.
CREATE TEMP TABLE _fallos (caso text, detalle text);

-- ── 0. El rol es el correcto ────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = current_user;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'Este guion no prueba nada como % (superusuario=%, bypassrls=%): RLS no se le aplica.',
      current_user, r.rolsuper, r.rolbypassrls;
  END IF;
  RAISE NOTICE 'Rol de prueba: % (sin superusuario, sin BYPASSRLS)', current_user;
END $$;

-- ════ 1. Club MON ve lo suyo ════════════════════════════════════════
BEGIN;
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM conversations;
  IF n = 2 THEN RAISE NOTICE 'OK     · 1 MON ve sus 2 conversaciones';
  ELSE INSERT INTO _fallos VALUES ('1', format('MON ve %s conversaciones, esperaba 2', n));
       RAISE NOTICE 'FALLA  · 1 MON ve % conversaciones, esperaba 2', n; END IF;
END $$;
COMMIT;

-- ════ 2. Misma conexión, sin contexto → 0 filas, sin excepción ══════
-- Este es el caso que rompe todo si la variable fuera de sesión.
DO $$
DECLARE n bigint; v text;
BEGIN
  v := current_setting('app.current_club_id', true);
  IF v IS NULL OR v = '' THEN
    RAISE NOTICE 'OK     · 2a la variable no sobrevivió a la transacción (valor: %)', coalesce(v,'NULL');
  ELSE INSERT INTO _fallos VALUES ('2a', 'la variable sigue pegada a la conexión: '||v);
       RAISE NOTICE 'FALLA  · 2a la variable sigue pegada a la conexión: %', v; END IF;

  -- Sin contexto: cero filas y NINGUNA excepción. Fallar cerrado es
  -- devolver nada, no reventar: si reventara, un bug de contexto se vería
  -- como una caída del servicio en vez de como una lista vacía.
  SELECT count(*) INTO n FROM conversations;
  IF n = 0 THEN RAISE NOTICE 'OK     · 2b sin contexto → 0 filas, sin excepción';
  ELSE INSERT INTO _fallos VALUES ('2b', format('sin contexto se leyeron %s filas', n));
       RAISE NOTICE 'FALLA  · 2b sin contexto se leyeron % filas', n; END IF;
END $$;

-- ════ 3. Misma conexión, ahora el Promoter ══════════════════════════
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE mon bigint; mias bigint; club text;
BEGIN
  club := current_setting('app.current_club_id', true);
  IF coalesce(club,'') = '' THEN RAISE NOTICE 'OK     · 3a no heredó el club del Promoter anterior';
  ELSE INSERT INTO _fallos VALUES ('3a', 'heredó app.current_club_id = '||club);
       RAISE NOTICE 'FALLA  · 3a heredó app.current_club_id = %', club; END IF;

  SELECT count(*) INTO mon FROM conversations WHERE "ownerType" = 'CLUB';
  IF mon = 0 THEN RAISE NOTICE 'OK     · 3b Promoter B no ve conversaciones de Club A';
  ELSE INSERT INTO _fallos VALUES ('3b', format('el Promoter ve %s conversaciones de club', mon));
       RAISE NOTICE 'FALLA  · 3b el Promoter ve % conversaciones de club', mon; END IF;

  SELECT count(*) INTO mias FROM conversations WHERE "ownerPromoterId" = 'prom_javi';
  IF mias = 1 THEN RAISE NOTICE 'OK     · 3c el Promoter ve la suya';
  ELSE INSERT INTO _fallos VALUES ('3c', format('el Promoter ve %s propias, esperaba 1', mias));
       RAISE NOTICE 'FALLA  · 3c el Promoter ve % propias, esperaba 1', mias; END IF;
END $$;
COMMIT;

-- ════ 4. Club A no ve Club B ════════════════════════════════════════
BEGIN;
SELECT set_config('app.current_club_id', 'club_lib', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE ajenas bigint; propias bigint;
BEGIN
  SELECT count(*) INTO ajenas  FROM conversations WHERE "ownerClubId" = 'club_mon';
  SELECT count(*) INTO propias FROM conversations WHERE "ownerClubId" = 'club_lib';
  IF ajenas = 0 THEN RAISE NOTICE 'OK     · 4a Liberata no ve nada de MON';
  ELSE INSERT INTO _fallos VALUES ('4a', format('Liberata ve %s filas de MON', ajenas));
       RAISE NOTICE 'FALLA  · 4a Liberata ve % filas de MON', ajenas; END IF;
  IF propias = 1 THEN RAISE NOTICE 'OK     · 4b Liberata ve la suya';
  ELSE INSERT INTO _fallos VALUES ('4b', format('Liberata ve %s propias, esperaba 1', propias));
       RAISE NOTICE 'FALLA  · 4b Liberata ve % propias, esperaba 1', propias; END IF;
END $$;
COMMIT;

-- ════ 5. contextClubId no concede acceso ════════════════════════════
-- `rp_cv_javi` es de Javier pero tiene contextClubId = club_mon: en algún
-- momento se habló de MON. MON no debe verla por eso.
BEGIN;
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM conversations WHERE "contextClubId" = 'club_mon' AND "ownerType" = 'PROMOTER';
  IF n = 0 THEN RAISE NOTICE 'OK     · 5 MON no ve el DM del RRPP pese a contextClubId = club_mon';
  ELSE INSERT INTO _fallos VALUES ('5', format('FUGA: MON lee %s DMs privados del RRPP', n));
       RAISE NOTICE 'FALLA  · 5 FUGA: MON lee % DMs privados del RRPP', n; END IF;
END $$;
COMMIT;

-- ════ 6. WITH CHECK: no se puede escribir para otro dueño ═══════════
-- Se prueba sobre `ai_request_logs` a propósito: es la única de las seis
-- **sin** trigger de propiedad que pueda adelantarse, así que lo único que
-- puede rechazar la fila aquí es la política.
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE ok boolean;
BEGIN
  ok := false;
  BEGIN
    INSERT INTO ai_request_logs (id, "resolvedBy", "ownerType", "ownerClubId", "createdAt")
    VALUES ('rp_leak', 'AI', 'CLUB', 'club_mon', now());
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'OK     · 6a WITH CHECK rechaza escribir con dueño ajeno';
  ELSE INSERT INTO _fallos VALUES ('6a', 'un RRPP plantó una fila con ownerClubId ajeno');
       RAISE NOTICE 'FALLA  · 6a un RRPP plantó una fila con ownerClubId ajeno'; END IF;

  -- Y el dueño legítimo sí puede escribir: sin esto, «todo rechazado»
  -- también pasaría el test de arriba.
  ok := true;
  BEGIN
    INSERT INTO ai_request_logs (id, "resolvedBy", "ownerType", "ownerPromoterId", "createdAt")
    VALUES ('rp_ok', 'AI', 'PROMOTER', 'prom_javi', now());
  EXCEPTION WHEN others THEN ok := false;
  END;
  IF ok THEN RAISE NOTICE 'OK     · 6b el dueño legítimo sí puede escribir';
  ELSE INSERT INTO _fallos VALUES ('6b', 'se rechazó una escritura legítima');
       RAISE NOTICE 'FALLA  · 6b se rechazó una escritura legítima'; END IF;
END $$;
ROLLBACK;

-- ════ 7. Conexión CONTAMINADA a nivel de sesión ═════════════════════
-- El caso importante, y el que justifica fijar SIEMPRE las dos variables.
--
-- Se ensucia la conexión a propósito con `set_config(..., false)`, que es lo
-- que haría código viejo o mal escrito: la variable queda pegada a la
-- conexión y sobrevive a los COMMIT. Después se simula lo que hace
-- forOwner(PROMOTER): abrir transacción y fijar LAS DOS, la del club vacía.
--
-- Si forOwner solo fijara la variable del promoter, el club contaminado
-- seguiría ahí y el promoter vería las filas de ese club. Fijar la vacía es
-- lo que lo impide.
SELECT set_config('app.current_club_id', 'club_mon', false);   -- ← contaminación deliberada
DO $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_club_id', true);
  IF v = 'club_mon' THEN
    RAISE NOTICE 'OK     · 7a la conexión quedó contaminada (así reproducimos el fallo)';
  ELSE INSERT INTO _fallos VALUES ('7a', 'no se pudo contaminar la conexión; el test 7 no probaría nada');
       RAISE NOTICE 'FALLA  · 7a no se pudo contaminar la conexión'; END IF;
END $$;

BEGIN;
-- Exactamente lo que hace forOwner({type:'PROMOTER'}): las DOS, siempre.
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE club text; prom text; mon bigint; mias bigint;
BEGIN
  club := current_setting('app.current_club_id', true);
  prom := current_setting('app.current_promoter_id', true);

  IF coalesce(club,'') = '' THEN
    RAISE NOTICE 'OK     · 7b la variable contaminada quedó pisada por la cadena vacía';
  ELSE INSERT INTO _fallos VALUES ('7b', 'sobrevivió el club contaminado: '||club);
       RAISE NOTICE 'FALLA  · 7b sobrevivió el club contaminado: %', club; END IF;

  IF prom = 'prom_javi' THEN RAISE NOTICE 'OK     · 7c el promoter correcto está fijado';
  ELSE INSERT INTO _fallos VALUES ('7c', 'promoter mal fijado: '||coalesce(prom,'NULL'));
       RAISE NOTICE 'FALLA  · 7c promoter mal fijado: %', coalesce(prom,'NULL'); END IF;

  SELECT count(*) INTO mon FROM conversations WHERE "ownerClubId" = 'club_mon';
  IF mon = 0 THEN
    RAISE NOTICE 'OK     · 7d el Promoter ve 0 filas de CLUB_A pese a la contaminación previa';
  ELSE INSERT INTO _fallos VALUES ('7d', format('FUGA: %s filas de club_mon visibles para el promoter', mon));
       RAISE NOTICE 'FALLA  · 7d FUGA: % filas de club_mon visibles para el promoter', mon; END IF;

  SELECT count(*) INTO mias FROM conversations;
  IF mias = 1 THEN RAISE NOTICE 'OK     · 7e y sigue viendo exactamente la suya';
  ELSE INSERT INTO _fallos VALUES ('7e', format('el promoter ve %s filas en total, esperaba 1', mias));
       RAISE NOTICE 'FALLA  · 7e el promoter ve % filas en total, esperaba 1', mias; END IF;
END $$;
COMMIT;

-- Después del COMMIT la contaminación de sesión vuelve a aflorar: es lo
-- esperado, y por eso forOwner fija las dos en CADA transacción y no una
-- sola vez al conectar.
DO $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_club_id', true);
  IF v = 'club_mon' THEN
    RAISE NOTICE 'OK     · 7f tras el COMMIT reaparece la contaminación de sesión (esperado)';
  ELSE
    RAISE NOTICE 'AVISO  · 7f la contaminación no reapareció (%): no invalida nada', coalesce(v,'NULL');
  END IF;
END $$;
SELECT set_config('app.current_club_id', '', false);
SELECT set_config('app.current_promoter_id', '', false);

-- ════ 8. Contraejemplo: `false` deja la variable pegada ═════════════
-- No prueba el sistema, prueba el test: si con `false` la variable tampoco
-- sobreviviera, los casos 2a y 7 no estarían demostrando nada.
BEGIN;
SELECT set_config('app.current_club_id', 'club_lib', false);
COMMIT;
DO $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_club_id', true);
  IF v = 'club_lib' THEN
    RAISE NOTICE 'OK     · 8 con `false` la variable sobrevive al COMMIT (= la fuga que evitamos)';
  ELSE INSERT INTO _fallos VALUES ('8', 'el contraejemplo no reproduce; revisar el test');
       RAISE NOTICE 'FALLA  · 8 el contraejemplo no reproduce; revisar el test'; END IF;
END $$;
SELECT set_config('app.current_club_id', '', false);


-- ════ 9 · Contaminación INVERSA: promoter viejo → operación de club ══
-- El caso 7 prueba club→promoter. Este prueba el otro sentido, que es
-- igual de posible y se olvida más: una conexión donde quedó un RRPP
-- fijado a nivel de sesión, reutilizada para atender a un club.
SELECT set_config('app.current_promoter_id', 'prom_javi', false);  -- ← contaminación
DO $$
DECLARE v text;
BEGIN
  v := current_setting('app.current_promoter_id', true);
  IF v = 'prom_javi' THEN RAISE NOTICE 'OK     · 9a la conexión quedó contaminada con un RRPP';
  ELSE INSERT INTO _fallos VALUES ('9a', 'no se pudo contaminar con el RRPP'); END IF;
END $$;

BEGIN;
-- Exactamente lo que hace forOwner({type:'CLUB'}).
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE prom text; ajenas bigint; propias bigint;
BEGIN
  prom := current_setting('app.current_promoter_id', true);
  IF coalesce(prom,'') = '' THEN
    RAISE NOTICE 'OK     · 9b el RRPP contaminado quedó pisado por la cadena vacía';
  ELSE INSERT INTO _fallos VALUES ('9b', 'sobrevivió el promoter contaminado: '||prom);
       RAISE NOTICE 'FALLA  · 9b sobrevivió el promoter contaminado: %', prom; END IF;

  SELECT count(*) INTO ajenas FROM conversations WHERE "ownerType" = 'PROMOTER';
  IF ajenas = 0 THEN RAISE NOTICE 'OK     · 9c el club no ve conversaciones de RRPP pese a la contaminación';
  ELSE INSERT INTO _fallos VALUES ('9c', format('FUGA: el club ve %s conversaciones de RRPP', ajenas));
       RAISE NOTICE 'FALLA  · 9c FUGA: el club ve % conversaciones de RRPP', ajenas; END IF;

  SELECT count(*) INTO propias FROM conversations WHERE "ownerClubId" = 'club_mon';
  IF propias = 2 THEN RAISE NOTICE 'OK     · 9d y sigue viendo las suyas';
  ELSE INSERT INTO _fallos VALUES ('9d', format('el club ve %s propias, esperaba 2', propias));
       RAISE NOTICE 'FALLA  · 9d el club ve % propias, esperaba 2', propias; END IF;
END $$;
COMMIT;
SELECT set_config('app.current_club_id', '', false);
SELECT set_config('app.current_promoter_id', '', false);

-- ════ Recuento ══════════════════════════════════════════════════════
DO $$
DECLARE n int; det text;
BEGIN
  SELECT count(*), string_agg(caso||': '||detalle, ' | ') INTO n, det FROM _fallos;
  IF n = 0 THEN
    RAISE NOTICE '───────────────────────────────────────────────────';
    RAISE NOTICE 'rls-pooling-tests: TODO VERDE.';
  ELSE
    RAISE EXCEPTION 'rls-pooling-tests: % casos fallidos → %', n, det;
  END IF;
END $$;
