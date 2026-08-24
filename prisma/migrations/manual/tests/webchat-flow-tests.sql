-- ════════════════════════════════════════════════════════════════════
-- El flujo de webchat, exactamente como lo escribe la aplicación
--
-- Reproduce las sentencias que emite `src/packages/db/webchat.ts` para los
-- dos dueños posibles, con el rol real (`nl_app`) y con las DOS variables
-- de RLS fijadas igual que hace `withOwnerRls`.
--
-- Sirve para responder a una pregunta concreta que ningún test de
-- TypeScript puede contestar: **¿las filas que escribe el webchat pasan los
-- CHECK, los triggers y las políticas?**
--
--   psql -d migtest -U nl_app -v ON_ERROR_STOP=1 -f tests/webchat-flow-tests.sql
--
-- Nota sobre el fixture: `000-legacy-fixture.sql` es una réplica REDUCIDA
-- del esquema anterior — tiene las columnas que importaban para probar la
-- migración, no todas las de producción (`messages.intent`,
-- `provenanceJson`, los contadores de tokens…). Por eso aquí solo se
-- escriben las columnas que tienen que ver con la propiedad, que es lo que
-- este archivo comprueba. Las demás las cubre el typecheck contra el
-- cliente de Prisma real.
--
-- Los fallos se acumulan y al final se lanza una excepción.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE TEMP TABLE _wf (caso text, detalle text);

DO $$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = current_user;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION 'Como % no se prueba nada: RLS no se le aplica.', current_user;
  END IF;
  RAISE NOTICE 'Rol: % (sin superusuario, sin BYPASSRLS)', current_user;
END $$;

-- ════ A · Visitante en el perfil de un CLUB ═════════════════════════
BEGIN;
-- Lo que hace withOwnerRls({type:'CLUB'}): las dos, la otra vacía.
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);

DO $$
DECLARE ch text; cus text; cv text; n bigint;
BEGIN
  -- getOrCreateWebchatChannel: el canal ya existe (ch_mon_web).
  SELECT id INTO ch FROM channels WHERE "ownerType"='CLUB' AND "clubId"='club_mon' AND type='WEBCHAT';
  IF ch IS NULL THEN
    INSERT INTO channels (id,"ownerType","clubId",type,status,"createdAt","updatedAt")
    VALUES ('wf_ch_club','CLUB','club_mon','WEBCHAT','CONNECTED',now(),now()) RETURNING id INTO ch;
  END IF;

  -- customer.upsert con ownerFields + legacy de club
  INSERT INTO customers (id,"channelId","externalUserHash","ownerType","ownerClubId","ownerPromoterId",
                         "clubId","channelType","externalHandleHash",locale,"createdAt")
  VALUES ('wf_cus_club', ch, 'wf_hash_club','CLUB','club_mon',NULL,
          'club_mon','WEBCHAT','wf_hash_club','es',now())
  RETURNING id INTO cus;

  -- conversation.create con contextClubId
  INSERT INTO conversations (id,"ownerType","ownerClubId","ownerPromoterId","contextClubId",
                             "channelId","customerId","channelType","clubId",
                             "lastMessageAt","createdAt","expiresAt")
  VALUES ('wf_cv_club','CLUB','club_mon',NULL,'club_mon',
          ch,cus,'WEBCHAT','club_mon',now(),now(),now()+interval '90 days')
  RETURNING id INTO cv;

  -- los dos mensajes del turno
  INSERT INTO messages (id,"conversationId",role,content,"ownerType","ownerClubId","clubId","createdAt")
  VALUES ('wf_ms_c1',cv,'CUSTOMER','cuanto cuesta','CLUB','club_mon','club_mon',now()),
         ('wf_ms_a1',cv,'ASSISTANT','20€','CLUB','club_mon','club_mon',now());

  INSERT INTO ai_request_logs (id,"conversationId","resolvedBy","ownerType","ownerClubId","clubId","createdAt")
  VALUES ('wf_ai_1',cv,'LLM','CLUB','club_mon','club_mon',now());

  SELECT count(*) INTO n FROM messages WHERE "conversationId"=cv;
  IF n = 2 THEN RAISE NOTICE 'OK     · A el turno de un club se escribe entero';
  ELSE INSERT INTO _wf VALUES ('A', format('%s mensajes, esperaba 2', n)); END IF;
END $$;
ROLLBACK;

-- ════ B · Visitante en el perfil de un RRPP ═════════════════════════
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);

DO $$
DECLARE ch text; cus text; cv text; n bigint;
BEGIN
  SELECT id INTO ch FROM channels WHERE "ownerType"='PROMOTER' AND "promoterId"='prom_javi' AND type='WEBCHAT';
  IF ch IS NULL THEN
    INSERT INTO channels (id,"ownerType","clubId","promoterId",type,status,"createdAt","updatedAt")
    VALUES ('wf_ch_prom','PROMOTER',NULL,'prom_javi','WEBCHAT','CONNECTED',now(),now()) RETURNING id INTO ch;
  END IF;

  -- Sin campos legacy: para un RRPP se quedan a NULL a propósito.
  INSERT INTO customers (id,"channelId","externalUserHash","ownerType","ownerClubId","ownerPromoterId",
                         locale,"createdAt")
  VALUES ('wf_cus_prom', ch, 'wf_hash_prom','PROMOTER',NULL,'prom_javi','es',now())
  RETURNING id INTO cus;

  -- contextClubId = MON, dueño = Javier. Es EL caso del producto.
  INSERT INTO conversations (id,"ownerType","ownerClubId","ownerPromoterId","contextClubId",
                             "channelId","customerId","channelType","promoterId",
                             "lastMessageAt","createdAt","expiresAt")
  VALUES ('wf_cv_prom','PROMOTER',NULL,'prom_javi','club_mon',
          ch,cus,'WEBCHAT','prom_javi',now(),now(),now()+interval '90 days')
  RETURNING id INTO cv;

  INSERT INTO messages (id,"conversationId",role,content,"ownerType","ownerPromoterId","createdAt")
  VALUES ('wf_ms_c2',cv,'CUSTOMER','bro que tienes el sabado','PROMOTER','prom_javi',now()),
         ('wf_ms_a2',cv,'ASSISTANT','MON y Liberata','PROMOTER','prom_javi',now());

  INSERT INTO ai_request_logs (id,"conversationId","resolvedBy","ownerType","ownerPromoterId","promoterId","createdAt")
  VALUES ('wf_ai_2',cv,'LLM','PROMOTER','prom_javi','prom_javi',now());

  SELECT count(*) INTO n FROM messages WHERE "conversationId"=cv;
  IF n = 2 THEN RAISE NOTICE 'OK     · B el turno de un RRPP se escribe entero';
  ELSE INSERT INTO _wf VALUES ('B', format('%s mensajes, esperaba 2', n)); END IF;

  -- Y su clubId legacy sigue vacío: es lo que el rollback comprueba.
  SELECT count(*) INTO n FROM conversations WHERE id=cv AND "clubId" IS NULL;
  IF n = 1 THEN RAISE NOTICE 'OK     · B la conversación de RRPP no arrastra clubId legacy';
  ELSE INSERT INTO _wf VALUES ('B-legacy', 'la conversación de RRPP tiene clubId'); END IF;
END $$;
COMMIT;

-- ════ C · El club NO ve el DM del RRPP ══════════════════════════════
-- Aunque `contextClubId` sea club_mon. Es la consecuencia buscada de que
-- el dueño y el contexto sean cosas distintas.
BEGIN;
SELECT set_config('app.current_club_id', 'club_mon', true);
SELECT set_config('app.current_promoter_id', '', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM conversations WHERE id='wf_cv_prom';
  IF n = 0 THEN RAISE NOTICE 'OK     · C MON no ve el DM de Javier pese a contextClubId = club_mon';
  ELSE INSERT INTO _wf VALUES ('C', 'FUGA: el club lee el DM privado del RRPP'); END IF;

  SELECT count(*) INTO n FROM messages WHERE "conversationId"='wf_cv_prom';
  IF n = 0 THEN RAISE NOTICE 'OK     · C tampoco sus mensajes';
  ELSE INSERT INTO _wf VALUES ('C-msg', format('FUGA: el club lee %s mensajes ajenos', n)); END IF;
END $$;
COMMIT;

-- ════ D · Un owner mal puesto se rechaza ════════════════════════════
-- Si el día de mañana alguien escribiera el owner a mano en vez de
-- derivarlo del canal, esto es lo que pasa.
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DO $$
DECLARE ok boolean := false; ch text;
BEGIN
  SELECT id INTO ch FROM channels WHERE "ownerType"='PROMOTER' AND "promoterId"='prom_javi' AND type='WEBCHAT';
  BEGIN
    INSERT INTO customers (id,"channelId","externalUserHash","ownerType","ownerClubId",locale,"createdAt")
    VALUES ('wf_cus_bad', ch, 'wf_bad','CLUB','club_mon','es',now());
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'OK     · D un cliente con dueño ajeno al canal → rechazado';
  ELSE INSERT INTO _wf VALUES ('D', 'se aceptó un cliente con dueño distinto al del canal'); END IF;
END $$;
ROLLBACK;

-- ════ E · Limpieza ══════════════════════════════════════════════════
BEGIN;
SELECT set_config('app.current_club_id', '', true);
SELECT set_config('app.current_promoter_id', 'prom_javi', true);
DELETE FROM ai_request_logs WHERE id = 'wf_ai_2';
DELETE FROM messages       WHERE id IN ('wf_ms_c2','wf_ms_a2');
DELETE FROM conversations  WHERE id = 'wf_cv_prom';
DELETE FROM customers      WHERE id = 'wf_cus_prom';
DELETE FROM channels       WHERE id = 'wf_ch_prom';
COMMIT;

DO $$
DECLARE n int; det text;
BEGIN
  SELECT count(*), string_agg(caso||': '||detalle, ' | ') INTO n, det FROM _wf;
  IF n = 0 THEN RAISE NOTICE 'webchat-flow-tests: TODO VERDE.';
  ELSE RAISE EXCEPTION 'webchat-flow-tests: % casos fallidos → %', n, det;
  END IF;
END $$;
