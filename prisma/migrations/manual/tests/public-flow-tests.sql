-- ════════════════════════════════════════════════════════════════════
-- El flujo PÚBLICO, como nl_app
--
-- Las otras suites prueban que el aislamiento funciona. Esta prueba el
-- fallo que NO se parece a un fallo, y que es el que se coló en la
-- auditoría de app-04:
--
--     una relación anidada desde una raíz SIN políticas
--     hacia una tabla CON políticas
--     devuelve cero filas, sin error y sin log.
--
-- En Prisma eso es un `include`. En SQL es este JOIN. Es la misma cosa y
-- se comporta igual, así que se puede demostrar aquí sin Prisma.
--
--   psql -d migtest -U nl_app -v ON_ERROR_STOP=1 -f tests/public-flow-tests.sql
--
-- Se ejecuta DESPUÉS de 011: la política de dos caras de promoter_clubs y
-- promoter_events es la que hace posible el arreglo del caso 4.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE TEMP TABLE _p (caso text, detalle text);

-- ── 0. Este rol tiene que estar sujeto a RLS ────────────────────────
-- Si no lo estuviera, todo lo de abajo pasaría en verde sin probar nada:
-- un superusuario ve todas las filas siempre. Es la misma trampa que la
-- sonda de row_security de 001.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('app.current_club_id', '', true);
  PERFORM set_config('app.current_promoter_id', '', true);
  SELECT count(*) INTO n FROM conversations;
  IF n = 0 THEN RAISE NOTICE 'OK     · 0 el rol % está sujeto a RLS', current_user;
  ELSE INSERT INTO _p VALUES ('0',
    format('%s ve %s conversaciones sin contexto: NO está sujeto a RLS y esta suite no prueba nada',
           current_user, n));
  END IF;
END $$;

-- ── 1. La raíz pública se lee sin fijar nada ────────────────────────
-- Tiene que ser así: resolver el slug de la URL es lo PRIMERO que pasa, y
-- todavía no se sabe de qué club o de qué RRPP se trata. Por eso `clubs`
-- y `promoters` están deliberadamente fuera de RLS.
DO $$
DECLARE c bigint; p bigint;
BEGIN
  SELECT count(*) INTO c FROM clubs     WHERE slug = 'mon-madrid';
  SELECT count(*) INTO p FROM promoters WHERE slug = 'javier-de-leon';
  IF c = 1 AND p = 1 THEN
    RAISE NOTICE 'OK     · 1 la raíz pública (clubs, promoters) se resuelve sin contexto';
  ELSE INSERT INTO _p VALUES ('1',
    format('club=%s promoter=%s, esperaba 1 y 1 — ninguna página pública podría resolver su slug', c, p));
  END IF;
END $$;

-- ── 2. EL FALLO ─────────────────────────────────────────────────────
-- Esto es, letra por letra, lo que hacían las dos páginas públicas y
-- `resolveWebchatOwner`: partir de la raíz sin políticas y bajar por la
-- relación. Sin contexto, la raíz responde y la relación no. Y no hay
-- error: la consulta es perfectamente válida.
DO $$
DECLARE raiz bigint; anidado bigint;
BEGIN
  PERFORM set_config('app.current_club_id', '', true);
  PERFORM set_config('app.current_promoter_id', '', true);

  SELECT count(*) INTO raiz FROM promoters p WHERE p.slug = 'javier-de-leon';

  SELECT count(*) INTO anidado
    FROM promoters p
    JOIN promoter_clubs pc ON pc."promoterId" = p.id
   WHERE p.slug = 'javier-de-leon';

  IF raiz = 1 AND anidado = 0 THEN
    RAISE NOTICE 'OK     · 2 raíz=1 pero anidado=0: el include vuelve VACÍO sin dar error';
  ELSE INSERT INTO _p VALUES ('2',
    format('raiz=%s anidado=%s — esta suite asume que el anidado se filtra; si no, revisa 011', raiz, anidado));
  END IF;
END $$;

-- ── 3. Lo que ese fallo provocaba en el webchat ─────────────────────
-- `resolveWebchatOwner` decidía de quién es la conversación contando las
-- altas aprobadas del RRPP en ESTE club. Con el include, ese contador es
-- siempre 0, así que la rama «no aprobado → el dueño es el club» se
-- ejecutaba SIEMPRE.
--
-- Consecuencia: el bot contesta en nombre del club en el perfil del RRPP,
-- y el club se encuentra en su bandeja los DM que los clientes le mandan
-- al RRPP. Que es exactamente lo único que la propiedad polimórfica
-- existe para impedir.
DO $$
DECLARE aprobadas bigint;
BEGIN
  PERFORM set_config('app.current_club_id', '', true);
  PERFORM set_config('app.current_promoter_id', '', true);

  SELECT count(*) INTO aprobadas
    FROM promoters p
    JOIN promoter_clubs pc ON pc."promoterId" = p.id
   WHERE p.slug = 'javier-de-leon' AND pc."clubId" = 'club_mon' AND pc.status = 'APPROVED';

  IF aprobadas = 0 THEN
    RAISE NOTICE 'OK     · 3 con el include, el alta aprobada cuenta 0 → dueño CLUB para todos';
  ELSE INSERT INTO _p VALUES ('3', format('esperaba 0 con el include, obtuve %s', aprobadas));
  END IF;
END $$;

-- ── 4. EL ARREGLO ───────────────────────────────────────────────────
-- La raíz se lee global (caso 1) y el alta se lee en contexto del RRPP.
-- No hace falta fijar ningún club: la política de dos caras de 011
-- reconoce al promoter como dueño legítimo de su propia alta.
BEGIN;
SELECT set_config('app.current_club_id',     '',          true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE aprobadas bigint; eventos bigint;
BEGIN
  SELECT count(*) INTO aprobadas
    FROM promoter_clubs
   WHERE "promoterId" = 'prom_javi' AND "clubId" = 'club_mon' AND status = 'APPROVED';

  IF aprobadas = 1 THEN RAISE NOTICE 'OK     · 4a en contexto PROMOTER el alta se ve → dueño PROMOTER';
  ELSE INSERT INTO _p VALUES ('4a', format('%s altas, esperaba 1 — el RRPP seguiría sin ser dueño', aprobadas)); END IF;

  -- Y lo que necesita /[promoterSlug]: sus eventos elegidos, de todos sus
  -- clubs a la vez, sin fijar ninguno.
  SELECT count(*) INTO eventos FROM promoter_events WHERE "promoterId" = 'prom_javi';
  IF eventos = 1 THEN RAISE NOTICE 'OK     · 4b y sus eventos elegidos, sin fijar ningún club';
  ELSE INSERT INTO _p VALUES ('4b', format('%s eventos, esperaba 1 — el perfil saldría sin noches', eventos)); END IF;
END $$;
COMMIT;

-- ── 5. El arreglo no abre nada ──────────────────────────────────────
-- Leer en contexto de RRPP le da lo suyo y solo lo suyo: las
-- conversaciones siguen siendo del dueño que diga la fila.
BEGIN;
SELECT set_config('app.current_club_id',     '',          true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE mias bigint; ajenas bigint;
BEGIN
  SELECT count(*) INTO mias   FROM conversations WHERE id = 'rp_cv_javi';
  SELECT count(*) INTO ajenas FROM conversations WHERE "ownerType" = 'CLUB';
  IF mias = 1 THEN RAISE NOTICE 'OK     · 5a el RRPP ve su conversación';
  ELSE INSERT INTO _p VALUES ('5a', format('el RRPP ve %s de las suyas, esperaba 1', mias)); END IF;
  IF ajenas = 0 THEN RAISE NOTICE 'OK     · 5b y ninguna del club';
  ELSE INSERT INTO _p VALUES ('5b', format('FUGA: el RRPP ve %s conversaciones de club', ajenas)); END IF;
END $$;
COMMIT;

-- ── 6. contextClubId no concede absolutamente nada ──────────────────
-- `rp_cv_javi` tiene contextClubId='club_mon': en esa conversación se
-- habló de MON. MON no puede verla. El contexto es de qué se habla; el
-- dueño es de quién es. No aparece en ninguna política y este caso es la
-- prueba de que no aparece.
BEGIN;
SELECT set_config('app.current_club_id',     'club_mon', true);
SELECT set_config('app.current_promoter_id', '',         true);
DO $$
DECLARE n bigint; ajenas bigint; propias bigint;
BEGIN
  SELECT count(*) INTO n FROM conversations WHERE id = 'rp_cv_javi';
  IF n = 0 THEN RAISE NOTICE 'OK     · 6a MON NO ve la conversación del RRPP aunque hable de MON';
  ELSE INSERT INTO _p VALUES ('6a', 'FUGA: contextClubId dio acceso — el club lee los DM del RRPP'); END IF;

  -- El caso general, y hay que enunciarlo con cuidado. Contar TODAS las
  -- filas con contextClubId='club_mon' no vale: las propias de MON también
  -- lo llevan (001 lo rellenó con su clubId al migrar) y se ven porque son
  -- SUYAS, no por el contexto. La pregunta correcta es si el contexto deja
  -- ver alguna que NO sea suya.
  --
  -- Lo aprendí porque la primera versión de este caso contaba mal y salió
  -- roja contra PostgreSQL de verdad. Una guarda que no distingue «visible
  -- porque es mía» de «visible por el contexto» no prueba nada.
  SELECT count(*) INTO ajenas FROM conversations
   WHERE "contextClubId" = 'club_mon' AND "ownerType" <> 'CLUB';
  IF ajenas = 0 THEN RAISE NOTICE 'OK     · 6b ninguna fila ajena se cuela por el contexto';
  ELSE INSERT INTO _p VALUES ('6b', format('FUGA: %s filas ajenas visibles por contextClubId', ajenas)); END IF;

  -- Y la contraprueba: lo que SÍ ve es lo que le pertenece.
  SELECT count(*) INTO propias FROM conversations
   WHERE "contextClubId" = 'club_mon' AND "ownerType" = 'CLUB' AND "ownerClubId" = 'club_mon';
  IF propias > 0 THEN RAISE NOTICE 'OK     · 6c y lo que ve son sus propias conversaciones (%)', propias;
  ELSE INSERT INTO _p VALUES ('6c', 'MON no ve ni las suyas: el aislamiento se pasó de frenada'); END IF;
END $$;
COMMIT;

-- ── 7. El canal sigue siendo la puerta de entrada ───────────────────
-- La cadena del webchat es canal → cliente → conversación → mensaje, y el
-- dueño cuelga del canal. Se comprueba entera desde el contexto del RRPP,
-- y que el club no ve ni el primer eslabón.
BEGIN;
SELECT set_config('app.current_club_id',     '',          true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE cadena bigint;
BEGIN
  SELECT count(*) INTO cadena
    FROM channels ch
    JOIN customers cu     ON cu."channelId" = ch.id
    JOIN conversations cv ON cv."channelId" = ch.id
    JOIN messages ms      ON ms."conversationId" = cv.id
   WHERE ch.id = 'rp_ch_javi_ig';
  IF cadena >= 1 THEN RAISE NOTICE 'OK     · 7a la cadena canal→cliente→conversación→mensaje se lee entera';
  ELSE INSERT INTO _p VALUES ('7a', 'la cadena del webchat del RRPP no se ve desde su propio contexto'); END IF;
END $$;
COMMIT;

BEGIN;
SELECT set_config('app.current_club_id',     'club_mon', true);
SELECT set_config('app.current_promoter_id', '',         true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM channels WHERE id = 'rp_ch_javi_ig';
  IF n = 0 THEN RAISE NOTICE 'OK     · 7b y el club no ve ni el canal del RRPP';
  ELSE INSERT INTO _p VALUES ('7b', 'FUGA: el club ve el canal del RRPP'); END IF;
END $$;
COMMIT;

-- ── Resultado ───────────────────────────────────────────────────────
DO $$
DECLARE n int; det text;
BEGIN
  SELECT count(*), string_agg(caso||': '||detalle, ' | ') INTO n, det FROM _p;
  IF n = 0 THEN RAISE NOTICE 'public-flow-tests: TODO VERDE.';
  ELSE RAISE EXCEPTION 'public-flow-tests: % casos fallidos → %', n, det;
  END IF;
END $$;
