-- ════════════════════════════════════════════════════════════════════
-- Pruebas de los triggers de propiedad
--
-- Se ejecutan DESPUÉS de 000-legacy-fixture.sql + 001-channel-owner.sql
-- sobre una base desechable, con el rol de migraciones (sin RLS aplicado:
-- aquí se prueban los TRIGGERS, no las políticas — eso es
-- rls-pooling-tests.sql).
--
--   psql -d migtest -v ON_ERROR_STOP=1 -f tests/trigger-tests.sql
--
-- Los fallos se ACUMULAN y al final se lanza una excepción. Con
-- ON_ERROR_STOP=1 el proceso termina con código distinto de cero: «tests en
-- verde» significa verde de verdad, no una lista de NOTICE que nadie lee.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

-- ── UNA transacción que SIEMPRE se deshace ──────────────────────────
-- Importante que sea explícita: en psql un `DO $$ ... $$;` suelto es una
-- sentencia y por tanto su propia transacción, que se CONFIRMA al terminar
-- bien. Los datos de prueba (y el DELETE del promoter del caso B2) se
-- quedarían escritos. Con BEGIN ... ROLLBACK alrededor no queda nada, el
-- guion es reejecutable sin limpieza previa, y si algo falla el RAISE
-- EXCEPTION aborta igual y psql sale con código distinto de cero.
BEGIN;

-- ── Escenario ───────────────────────────────────────────────────────
-- Dos promoters (Javier y otro) y los dos clubs del fixture. El canal de
-- Instagram de Javier es el que da juego: es el primer canal que no
-- pertenece a ningún club.
INSERT INTO promoters (id, slug, "displayName")
VALUES ('tt_prom_otro', 'tt-otro', 'Otro RRPP');

-- WHATSAPP y no INSTAGRAM: el seed de RLS ya le dio a Javier un canal de
-- Instagram, y `channels_promoter_type_key` impide que un mismo RRPP tenga
-- dos del mismo tipo. Que ese índice haya hecho fallar el test la primera
-- vez es buena señal: está haciendo su trabajo.
INSERT INTO channels (id, "ownerType", "clubId", "promoterId", type, status, "createdAt", "updatedAt")
VALUES ('tt_ch_javi_ig', 'PROMOTER', NULL, 'prom_javi', 'WHATSAPP', 'CONNECTED', now(), now());

-- Cliente y conversación de Javier, creados SIN owner: se deriva.
INSERT INTO customers (id, "channelId", "externalUserHash", "displayName", locale, "createdAt")
VALUES ('tt_cus_javi', 'tt_ch_javi_ig', 'tt_hash_javi', 'Cliente Javi', 'es', now());

INSERT INTO conversations (id, "customerId", "channelId", "channelType", status,
                           "lastMessageAt", "createdAt", "expiresAt")
VALUES ('tt_cv_javi', 'tt_cus_javi', 'tt_ch_javi_ig', 'WHATSAPP', 'AI_ACTIVE',
        now(), now(), now() + interval '90 days');

-- ── Los casos ───────────────────────────────────────────────────────
DO $$
DECLARE
  fallos int := 0;
  r      record;
  ok     boolean;

  -- Helper mental: `intentar` = esperamos que reviente. `permitir` =
  -- esperamos que pase. plpgsql no tiene funciones locales, así que cada
  -- caso lleva su propio bloque BEGIN/EXCEPTION. Es verboso pero explícito.
BEGIN

RAISE NOTICE '── Derivación (owner vacío → se hereda) ───────────';

SELECT "ownerType", "ownerClubId", "ownerPromoterId" INTO r
  FROM conversations WHERE id = 'tt_cv_javi';
IF r."ownerType" = 'PROMOTER' AND r."ownerPromoterId" = 'prom_javi' AND r."ownerClubId" IS NULL THEN
  RAISE NOTICE 'OK     · D1 Conversation sin owner hereda el del canal';
ELSE fallos := fallos+1;
  RAISE NOTICE 'FALLA  · D1 Conversation derivó % / % / %', r."ownerType", r."ownerClubId", r."ownerPromoterId";
END IF;

SELECT "ownerType", "ownerClubId", "ownerPromoterId" INTO r
  FROM customers WHERE id = 'tt_cus_javi';
IF r."ownerType" = 'PROMOTER' AND r."ownerPromoterId" = 'prom_javi' AND r."ownerClubId" IS NULL THEN
  RAISE NOTICE 'OK     · D2 Customer sin owner hereda el del canal';
ELSE fallos := fallos+1;
  RAISE NOTICE 'FALLA  · D2 Customer derivó % / % / %', r."ownerType", r."ownerClubId", r."ownerPromoterId";
END IF;

BEGIN
  INSERT INTO messages (id, "conversationId", role, content, "createdAt")
  VALUES ('tt_ms_der', 'tt_cv_javi', 'CUSTOMER', 'hola', now());
  SELECT "ownerType", "ownerPromoterId" INTO r FROM messages WHERE id = 'tt_ms_der';
  IF r."ownerType" = 'PROMOTER' AND r."ownerPromoterId" = 'prom_javi' THEN
    RAISE NOTICE 'OK     · D3 Message sin owner hereda el de la conversación';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · D3 Message derivó % / %', r."ownerType", r."ownerPromoterId"; END IF;
EXCEPTION WHEN others THEN
  fallos := fallos+1; RAISE NOTICE 'FALLA  · D3 Message sin owner fue rechazado: %', SQLERRM;
END;

BEGIN
  INSERT INTO follow_ups (id, "conversationId", "suggestedMessage")
  VALUES ('tt_fu_der', 'tt_cv_javi', '¿Te reservo?');
  SELECT "ownerType", "ownerPromoterId" INTO r FROM follow_ups WHERE id = 'tt_fu_der';
  IF r."ownerType" = 'PROMOTER' AND r."ownerPromoterId" = 'prom_javi' THEN
    RAISE NOTICE 'OK     · D4 FollowUp sin owner hereda el de la conversación';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · D4 FollowUp derivó % / %', r."ownerType", r."ownerPromoterId"; END IF;
EXCEPTION WHEN others THEN
  fallos := fallos+1; RAISE NOTICE 'FALLA  · D4 FollowUp sin owner fue rechazado: %', SQLERRM;
END;

BEGIN
  INSERT INTO ai_request_logs (id, "conversationId", "resolvedBy", "createdAt")
  VALUES ('tt_ai_der', 'tt_cv_javi', 'LLM', now());
  SELECT "ownerType", "ownerPromoterId" INTO r FROM ai_request_logs WHERE id = 'tt_ai_der';
  IF r."ownerType" = 'PROMOTER' AND r."ownerPromoterId" = 'prom_javi' THEN
    RAISE NOTICE 'OK     · D5 AiRequestLog con conversación hereda su owner';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · D5 AiRequestLog derivó % / %', r."ownerType", r."ownerPromoterId"; END IF;
EXCEPTION WHEN others THEN
  fallos := fallos+1; RAISE NOTICE 'FALLA  · D5 AiRequestLog fue rechazado: %', SQLERRM;
END;

-- Sin conversación no hay de dónde derivar: el owner tiene que venir del
-- contexto de servidor, y si no viene se rechaza en vez de inventarlo.
ok := false;
BEGIN
  INSERT INTO ai_request_logs (id, "resolvedBy", "createdAt")
  VALUES ('tt_ai_sin', 'LLM', now());
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · D6 AiRequestLog sin conversación NI owner → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · D6 se aceptó un log sin conversación y sin owner'; END IF;

ok := true;
BEGIN
  INSERT INTO ai_request_logs (id, "resolvedBy", "ownerType", "ownerPromoterId", "createdAt")
  VALUES ('tt_ai_ctx', 'LLM', 'PROMOTER', 'prom_javi', now());
EXCEPTION WHEN others THEN ok := false;
END;
IF ok THEN RAISE NOTICE 'OK     · D7 AiRequestLog sin conversación pero con owner de contexto → aceptado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · D7 se rechazó un log con owner de contexto válido'; END IF;

RAISE NOTICE '── Owner incorrecto → REJECT ──────────────────────';

ok := false;
BEGIN
  INSERT INTO conversations (id, "customerId", "channelId", "channelType",
                             "ownerType", "ownerPromoterId", status,
                             "lastMessageAt", "createdAt", "expiresAt")
  VALUES ('tt_cv_A', 'tt_cus_javi', 'tt_ch_javi_ig', 'WHATSAPP',
          'PROMOTER', 'tt_prom_otro', 'AI_ACTIVE', now(), now(), now() + interval '90 days');
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · R1 Conversation con otro promoter en canal de Javier → rechazada';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · R1 se aceptó una conversación con el promoter equivocado'; END IF;

ok := false;
BEGIN
  INSERT INTO messages (id, "conversationId", role, content,
                        "ownerType", "ownerPromoterId", "createdAt")
  VALUES ('tt_ms_B', 'tt_cv_javi', 'CUSTOMER', 'hola', 'PROMOTER', 'tt_prom_otro', now());
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · R2 Message con otro promoter → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · R2 se aceptó un mensaje con dueño ajeno'; END IF;

ok := false;
BEGIN
  INSERT INTO customers (id, "channelId", "externalUserHash", "ownerType", "ownerClubId",
                         "displayName", locale, "createdAt")
  VALUES ('tt_cus_C', 'ch_mon_web', 'tt_hash_C', 'CLUB', 'club_lib', 'Intruso', 'es', now());
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · R3 Customer con club ajeno en canal de MON → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · R3 se aceptó un cliente con el club equivocado'; END IF;

ok := false;
BEGIN
  INSERT INTO follow_ups (id, "conversationId", "suggestedMessage",
                          "ownerType", "ownerClubId")
  VALUES ('tt_fu_bad', 'tt_cv_javi', 'x', 'CLUB', 'club_mon');
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · R4 FollowUp con owner de club en conversación de RRPP → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · R4 se aceptó un follow-up con dueño ajeno'; END IF;

ok := false;
BEGIN
  INSERT INTO ai_request_logs (id, "conversationId", "resolvedBy",
                               "ownerType", "ownerClubId", "createdAt")
  VALUES ('tt_ai_bad', 'tt_cv_javi', 'LLM', 'CLUB', 'club_mon', now());
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · R5 AiRequestLog con owner ajeno → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · R5 se aceptó un log con dueño ajeno'; END IF;

RAISE NOTICE '── Mismo owner enviado → ACCEPT ───────────────────';
-- No es un detalle: Prisma manda TODOS los campos del objeto en un UPDATE,
-- no solo los que cambiaron. Si reescribir el mismo owner fallara,
-- cualquier `conversation.update()` normal reventaría en producción.

ok := true;
BEGIN
  INSERT INTO customers (id, "channelId", "externalUserHash", "ownerType", "ownerClubId",
                         "displayName", locale, "createdAt")
  VALUES ('tt_cus_ok', 'ch_mon_web', 'tt_hash_ok', 'CLUB', 'club_mon', 'Legítimo', 'es', now());
EXCEPTION WHEN others THEN ok := false;
END;
IF ok THEN RAISE NOTICE 'OK     · A1 INSERT con el owner correcto explícito → aceptado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · A1 se rechazó un owner correcto'; END IF;

ok := true;
BEGIN
  UPDATE conversations
     SET "ownerType" = 'CLUB', "ownerClubId" = 'club_mon', "ownerPromoterId" = NULL,
         status = 'HUMAN_ACTIVE'
   WHERE id = 'cv_1';
  UPDATE conversations SET status = 'AI_ACTIVE' WHERE id = 'cv_1';
EXCEPTION WHEN others THEN ok := false;
END;
IF ok THEN RAISE NOTICE 'OK     · A2 UPDATE reescribiendo el MISMO owner → permitido (patrón Prisma)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · A2 un update normal de Prisma reventaría'; END IF;

RAISE NOTICE '── Cambiar owner → REJECT ─────────────────────────';

ok := false;
BEGIN
  UPDATE channels SET "promoterId" = 'tt_prom_otro' WHERE id = 'tt_ch_javi_ig';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I1 Channel.owner inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I1 se pudo cambiar el dueño de un canal'; END IF;

ok := false;
BEGIN
  UPDATE conversations SET "ownerClubId" = 'club_lib' WHERE id = 'cv_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I2 Conversation.owner inmutable (con mensajes colgando)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I2 se pudo cambiar el dueño de una conversación'; END IF;

ok := false;
BEGIN
  UPDATE conversations
     SET "ownerType" = 'PROMOTER', "ownerClubId" = NULL, "ownerPromoterId" = 'prom_javi'
   WHERE id = 'cv_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I3 salto de CLUB a PROMOTER → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I3 una conversación de club pasó a un promoter'; END IF;

ok := false;
BEGIN
  UPDATE conversations
     SET "ownerType" = NULL, "ownerClubId" = NULL, "ownerPromoterId" = NULL
   WHERE id = 'cv_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I4 vaciar el owner para forzar derivación → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I4 se pudo vaciar el owner (puerta trasera)'; END IF;

ok := false;
BEGIN
  UPDATE messages SET "ownerClubId" = 'club_lib' WHERE id = 'ms_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I5 Message.owner inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I5 se pudo cambiar el dueño de un mensaje'; END IF;

ok := false;
BEGIN
  UPDATE follow_ups SET "ownerClubId" = 'club_lib' WHERE id = 'fu_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I6 FollowUp.owner inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I6 se pudo cambiar el dueño de un follow-up'; END IF;

ok := false;
BEGIN
  UPDATE ai_request_logs SET "ownerClubId" = 'club_lib' WHERE id = 'ai_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · I7 AiRequestLog.owner inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · I7 se pudo cambiar el dueño de un log'; END IF;

RAISE NOTICE '── Cambiar el puntero al padre → REJECT ───────────';
-- Sin esto habría una puerta trasera: no toco el owner, muevo la fila a un
-- canal o una conversación de otro y el owner deja de cuadrar sin que
-- ningún trigger se queje.

ok := false;
BEGIN
  UPDATE conversations SET "channelId" = 'tt_ch_javi_ig' WHERE id = 'cv_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · P1 Conversation.channelId inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · P1 se pudo mover una conversación de canal'; END IF;

ok := false;
BEGIN
  UPDATE customers SET "channelId" = 'tt_ch_javi_ig' WHERE id = 'cus_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · P2 Customer.channelId inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · P2 se pudo mover un cliente de canal'; END IF;

ok := false;
BEGIN
  UPDATE messages SET "conversationId" = 'tt_cv_javi' WHERE id = 'ms_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · P3 Message.conversationId inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · P3 se pudo mover un mensaje de conversación'; END IF;

ok := false;
BEGIN
  UPDATE follow_ups SET "conversationId" = 'tt_cv_javi' WHERE id = 'fu_1';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · P4 FollowUp.conversationId inmutable';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · P4 se pudo mover un follow-up de conversación'; END IF;

RAISE NOTICE '── contextClubId SÍ es mutable ────────────────────';

ok := true;
BEGIN
  UPDATE conversations SET "contextClubId" = NULL       WHERE id = 'tt_cv_javi';
  UPDATE conversations SET "contextClubId" = 'club_mon' WHERE id = 'tt_cv_javi';
  UPDATE conversations SET "contextClubId" = 'club_lib' WHERE id = 'tt_cv_javi';
EXCEPTION WHEN others THEN ok := false;
END;
SELECT "contextClubId", "ownerType", "ownerPromoterId" INTO r
  FROM conversations WHERE id = 'tt_cv_javi';
IF ok AND r."contextClubId" = 'club_lib' AND r."ownerPromoterId" = 'prom_javi' THEN
  RAISE NOTICE 'OK     · C1 contextClubId cambia libremente sin tocar el dueño';
ELSE fallos := fallos+1;
  RAISE NOTICE 'FALLA  · C1 contextClubId: % / % / %', r."contextClubId", r."ownerType", r."ownerPromoterId";
END IF;

RAISE NOTICE '── Borrar un canal no destruye historial ──────────';

ok := false;
BEGIN
  DELETE FROM channels WHERE id = 'tt_ch_javi_ig';
EXCEPTION WHEN others THEN ok := true;
END;
IF ok THEN RAISE NOTICE 'OK     · B1 DELETE de un canal con historial → rechazado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · B1 se borró un canal con conversaciones colgando'; END IF;

-- Pero el dueño sí puede borrarse a sí mismo con todo lo suyo: el NO ACTION
-- del canal se comprueba al final de la sentencia, cuando los CASCADE de
-- propiedad ya han limpiado. Se prueba y se deshace.
ok := true;
BEGIN
  DELETE FROM promoters WHERE id = 'prom_javi';
EXCEPTION WHEN others THEN ok := false;
END;
IF ok THEN RAISE NOTICE 'OK     · B2 borrar el promoter arrastra sus canales y su historial';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · B2 no se pudo borrar un promoter con datos propios'; END IF;

RAISE NOTICE '───────────────────────────────────────────────────';
IF fallos = 0 THEN
  RAISE NOTICE 'trigger-tests: TODO VERDE.';
ELSE
  RAISE EXCEPTION 'trigger-tests: % casos fallidos.', fallos;
END IF;
END $$;

-- Nada de lo anterior se conserva: ni los datos de prueba ni el DELETE del
-- promoter del caso B2. La base queda exactamente como estaba.
ROLLBACK;
