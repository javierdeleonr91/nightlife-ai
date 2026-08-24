-- ════════════════════════════════════════════════════════════════════
-- Deshacer 001-channel-owner.sql
--
-- Es posible **sin pérdida de datos** porque la migración es aditiva: no
-- borró ninguna columna. Toda la información original sigue en `clubId`,
-- `channelType` y `externalHandleHash`, intacta.
--
-- Lo que NO cabe en el modelo viejo son las filas de promoter: el modelo
-- legacy exige un `clubId` en todas las tablas, y una conversación de RRPP
-- no tiene ninguno. Por eso el paso 0 recorre las SEIS tablas y aborta si
-- encuentra una sola fila de promoter. No se pierde nada por accidente.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f 001-channel-owner-rollback.sql
--
-- Al terminar, el esquema vuelve al modelo de club y **las políticas RLS
-- antiguas basadas en clubId quedan restauradas**. Nunca se deja una tabla
-- con RLS activo y sin política: eso sería negar el acceso a todo el mundo
-- sin decir por qué.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ── -1. ¿Esta sesión ve todas las filas? ────────────────────────────
-- Si la conexión estuviera sujeta a RLS, el paso 0 contaría cero filas de
-- promoter aunque las hubiera, y este guion las borraría creyendo que no
-- existen. Mismo control que en la migración, por la misma razón.
DO $$
DECLARE filtrado boolean := false;
BEGIN
  BEGIN
    PERFORM set_config('row_security', 'off', true);
    PERFORM count(*) FROM conversations;
  EXCEPTION WHEN others THEN
    filtrado := true;
  END;
  PERFORM set_config('row_security', 'on', true);
  IF filtrado THEN
    RAISE EXCEPTION
      'El rol % está sujeto a RLS: el cortafuegos del paso 0 no vería los datos de promoter. Usa DIRECT_URL.',
      current_user;
  END IF;
END $$;

-- ── 0a. Las migraciones posteriores se deshacen primero ─────────────
-- Los triggers de 010 usan las funciones que crea 001. Si 010 sigue
-- aplicada, el DROP FUNCTION de más abajo falla con un mensaje que no
-- explica nada («cannot drop function ... because other objects depend on
-- it»). Mejor pararlo aquí y decir qué hacer.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='unanswered_questions') THEN
    RAISE EXCEPTION
      'La migración 010 sigue aplicada. Deshaz primero: psql "$DIRECT_URL" -f prisma/migrations/manual/010-beta-tables-rollback.sql';
  END IF;
END $$;

-- ── 0. Cortafuegos: nada de promoter en ninguna de las seis ─────────
DO $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
  parte text;
  det   text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','customers','conversations','messages',
                           'follow_ups','ai_request_logs'] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "ownerType" = ''PROMOTER''', t) INTO n;
    IF n > 0 THEN
      total := total + n;
      parte := format('%s: %s', t, n);
      det := CASE WHEN det = '' THEN parte ELSE det || ', ' || parte END;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION
      'Hay % filas de promoter (%). El modelo legacy exige clubId y no puede representarlas: deshacer las borraría. Decide qué hacer con ellas antes.',
      total, det;
  END IF;
END $$;

-- ── 0b. Quitar los triggers ANTES de tocar nada ─────────────────────
-- Tiene que ir aquí arriba: los UPDATE del paso 1 rellenan `clubId` y
-- `channelType`, y el trigger de inmutabilidad no distingue un rollback de
-- un intento de manipulación. Si se dejaran puestos, el propio guion que
-- deshace la migración se estrellaría contra ella.
DROP TRIGGER IF EXISTS nl_channel_immutable_t      ON channels;
DROP TRIGGER IF EXISTS nl_customer_channel_t       ON customers;
DROP TRIGGER IF EXISTS nl_customer_immutable_t     ON customers;
DROP TRIGGER IF EXISTS nl_customer_owner_t         ON customers;
DROP TRIGGER IF EXISTS nl_conversation_channel_t   ON conversations;
DROP TRIGGER IF EXISTS nl_conversation_immutable_t ON conversations;
DROP TRIGGER IF EXISTS nl_conversation_owner_t     ON conversations;
DROP TRIGGER IF EXISTS nl_message_conversation_t   ON messages;
DROP TRIGGER IF EXISTS nl_message_immutable_t      ON messages;
DROP TRIGGER IF EXISTS nl_message_owner_t          ON messages;
DROP TRIGGER IF EXISTS nl_followup_conversation_t  ON follow_ups;
DROP TRIGGER IF EXISTS nl_followup_immutable_t     ON follow_ups;
DROP TRIGGER IF EXISTS nl_followup_owner_t         ON follow_ups;
DROP TRIGGER IF EXISTS nl_ailog_conversation_t     ON ai_request_logs;
DROP TRIGGER IF EXISTS nl_ailog_immutable_t        ON ai_request_logs;
DROP TRIGGER IF EXISTS nl_ailog_owner_t            ON ai_request_logs;

DROP FUNCTION IF EXISTS nl_customer_owner();
DROP FUNCTION IF EXISTS nl_conversation_owner();
DROP FUNCTION IF EXISTS nl_child_owner_from_conversation();
DROP FUNCTION IF EXISTS nl_owner_immutable();
DROP FUNCTION IF EXISTS nl_channel_owner_immutable();
DROP FUNCTION IF EXISTS nl_channel_ref_immutable();
DROP FUNCTION IF EXISTS nl_conversation_ref_immutable();

-- ── 0c. Quitar las políticas de dueño polimórfico ───────────────────
-- Apuntan a columnas que este guion va a borrar; si se quedaran, el DROP
-- COLUMN del paso 4 fallaría por dependencia. Las legacy se restauran en el
-- paso 6: entre medias las tablas quedan con RLS activo y sin política, es
-- decir, cerradas — y todo esto va dentro de UNA transacción, así que esa
-- ventana no existe para nadie más.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','conversations','messages','customers',
                           'follow_ups','ai_request_logs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END $$;

-- ── 1. Restituir los valores legacy ─────────────────────────────────
-- Si el código nuevo llegó a escribir sin `clubId`, se rellena desde el
-- dueño, que a estas alturas solo puede ser un club (lo garantiza el paso 0).
UPDATE conversations   SET "clubId" = "ownerClubId" WHERE "clubId" IS NULL;
UPDATE messages        SET "clubId" = "ownerClubId" WHERE "clubId" IS NULL;
UPDATE customers       SET "clubId" = "ownerClubId" WHERE "clubId" IS NULL;
UPDATE follow_ups      SET "clubId" = "ownerClubId" WHERE "clubId" IS NULL;
UPDATE ai_request_logs SET "clubId" = "ownerClubId" WHERE "clubId" IS NULL;
UPDATE channels        SET "clubId" = "clubId"      WHERE false;  -- no-op documental

UPDATE customers c SET
  "channelType"        = ch.type,
  "externalHandleHash" = c."externalUserHash"
FROM channels ch
WHERE ch.id = c."channelId"
  AND (c."channelType" IS NULL OR c."externalHandleHash" IS NULL);

-- ── 2. Quitar restricciones e índices nuevos ────────────────────────
ALTER TABLE messages      DROP CONSTRAINT IF EXISTS messages_conversation_owner_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_id_owner_type_key;

ALTER TABLE channels        DROP CONSTRAINT IF EXISTS channels_one_owner;
ALTER TABLE conversations   DROP CONSTRAINT IF EXISTS conversations_one_owner;
ALTER TABLE messages        DROP CONSTRAINT IF EXISTS messages_one_owner;
ALTER TABLE customers       DROP CONSTRAINT IF EXISTS customers_one_owner;
ALTER TABLE follow_ups      DROP CONSTRAINT IF EXISTS follow_ups_one_owner;
ALTER TABLE ai_request_logs DROP CONSTRAINT IF EXISTS ai_request_logs_one_owner;

ALTER TABLE channels        DROP CONSTRAINT IF EXISTS channels_promoter_fkey;
ALTER TABLE customers       DROP CONSTRAINT IF EXISTS customers_channel_fkey;
ALTER TABLE customers       DROP CONSTRAINT IF EXISTS customers_owner_club_fkey;
ALTER TABLE customers       DROP CONSTRAINT IF EXISTS customers_owner_promoter_fkey;
ALTER TABLE conversations   DROP CONSTRAINT IF EXISTS conversations_owner_club_fkey;
ALTER TABLE conversations   DROP CONSTRAINT IF EXISTS conversations_owner_promoter_fkey;
ALTER TABLE conversations   DROP CONSTRAINT IF EXISTS conversations_context_club_fkey;
ALTER TABLE messages        DROP CONSTRAINT IF EXISTS messages_owner_club_fkey;
ALTER TABLE messages        DROP CONSTRAINT IF EXISTS messages_owner_promoter_fkey;
ALTER TABLE follow_ups      DROP CONSTRAINT IF EXISTS follow_ups_owner_club_fkey;
ALTER TABLE follow_ups      DROP CONSTRAINT IF EXISTS follow_ups_owner_promoter_fkey;
ALTER TABLE ai_request_logs DROP CONSTRAINT IF EXISTS ai_request_logs_owner_club_fkey;
ALTER TABLE ai_request_logs DROP CONSTRAINT IF EXISTS ai_request_logs_owner_promoter_fkey;

DROP INDEX IF EXISTS channels_type_external_key;
DROP INDEX IF EXISTS channels_promoter_type_key;
DROP INDEX IF EXISTS channels_owner_status_idx;
DROP INDEX IF EXISTS customers_channel_hash_key;
DROP INDEX IF EXISTS customers_owner_club_idx;
DROP INDEX IF EXISTS customers_owner_promoter_idx;
DROP INDEX IF EXISTS conversations_owner_club_status_idx;
DROP INDEX IF EXISTS conversations_owner_club_last_idx;
DROP INDEX IF EXISTS conversations_owner_promoter_status_idx;
DROP INDEX IF EXISTS conversations_owner_promoter_last_idx;
DROP INDEX IF EXISTS conversations_context_club_idx;
DROP INDEX IF EXISTS messages_owner_club_idx;
DROP INDEX IF EXISTS messages_owner_promoter_idx;

-- ── 3. Restituir la FK legacy conversations→channels ────────────────
-- La migración la cambió de ON DELETE SET NULL a NO ACTION porque
-- `channelId` pasaba a NOT NULL. Al volver atrás, `channelId` vuelve a ser
-- nullable y SET NULL vuelve a tener sentido.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_fkey;
ALTER TABLE conversations ALTER COLUMN "channelId" DROP NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_channelId_fkey
  FOREIGN KEY ("channelId") REFERENCES channels(id) ON DELETE SET NULL;

-- ── 4. Restituir obligatoriedad y quitar las columnas nuevas ────────
ALTER TABLE channels        ALTER COLUMN "clubId" SET NOT NULL;
ALTER TABLE conversations   ALTER COLUMN "clubId" SET NOT NULL;
ALTER TABLE messages        ALTER COLUMN "clubId" SET NOT NULL;
ALTER TABLE customers       ALTER COLUMN "clubId" SET NOT NULL;
ALTER TABLE customers       ALTER COLUMN "channelType" SET NOT NULL;
ALTER TABLE customers       ALTER COLUMN "externalHandleHash" SET NOT NULL;
ALTER TABLE follow_ups      ALTER COLUMN "clubId" SET NOT NULL;
ALTER TABLE ai_request_logs ALTER COLUMN "clubId" SET NOT NULL;

ALTER TABLE channels DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "promoterId",     DROP COLUMN IF EXISTS "displayName",
  DROP COLUMN IF EXISTS "tokenExpiresAt", DROP COLUMN IF EXISTS "autoReply",
  DROP COLUMN IF EXISTS "waMode",         DROP COLUMN IF EXISTS "lastErrorCode",
  DROP COLUMN IF EXISTS "updatedAt";

ALTER TABLE customers DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "ownerClubId",      DROP COLUMN IF EXISTS "ownerPromoterId",
  DROP COLUMN IF EXISTS "channelId",        DROP COLUMN IF EXISTS "externalUserHash",
  DROP COLUMN IF EXISTS "externalUserRef";

ALTER TABLE conversations DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "ownerClubId",   DROP COLUMN IF EXISTS "ownerPromoterId",
  DROP COLUMN IF EXISTS "contextClubId", DROP COLUMN IF EXISTS "locale";

ALTER TABLE messages DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "ownerClubId", DROP COLUMN IF EXISTS "ownerPromoterId";

ALTER TABLE follow_ups DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "ownerClubId", DROP COLUMN IF EXISTS "ownerPromoterId";

ALTER TABLE ai_request_logs DROP COLUMN IF EXISTS "ownerType",
  DROP COLUMN IF EXISTS "ownerClubId", DROP COLUMN IF EXISTS "ownerPromoterId";

DROP TYPE IF EXISTS "ChannelOwnerType";

-- ── 5. Los canales creados en el paso 4 de la migración ─────────────
-- Se identifican por su prefijo. Solo se borran los que no tengan nada
-- colgando: si algo los referencia, se quedan y no pasa nada — un canal de
-- webchat de más es inofensivo, y con la FK ya en SET NULL tampoco hay
-- riesgo de arrastrar historial.
DELETE FROM channels ch
WHERE ch.id LIKE 'ch_legacy_%'
  AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv."channelId" = ch.id);

-- ── 6. Restaurar las políticas RLS antiguas (basadas en clubId) ─────
-- Este paso es obligatorio. Una tabla con RLS activo y sin ninguna política
-- niega el acceso a todo el mundo, y lo hace devolviendo cero filas sin
-- error: el peor modo de fallo posible, porque parece que no hay datos.
--
-- Se replica exactamente lo que hace `prisma/rls.sql` para estas seis
-- tablas: comparación directa contra `clubId`, dirigida a PUBLIC como
-- estaba antes de esta migración.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','conversations','messages','customers',
                           'follow_ups','ai_request_logs'] LOOP
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

-- ── 7. Comprobar que la vuelta quedó bien ───────────────────────────
DO $$
DECLARE n bigint; t text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public'
     AND column_name IN ('ownerType','ownerClubId','ownerPromoterId','contextClubId');
  IF n > 0 THEN RAISE EXCEPTION 'Quedan % columnas nuevas sin borrar', n; END IF;

  SELECT count(*) INTO n FROM pg_type WHERE typname = 'ChannelOwnerType';
  IF n > 0 THEN RAISE EXCEPTION 'El tipo ChannelOwnerType sigue existiendo'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname LIKE 'nl@_%' ESCAPE '@';
  IF n > 0 THEN RAISE EXCEPTION 'Quedan % triggers nl_', n; END IF;

  SELECT count(*) INTO n FROM pg_proc WHERE proname LIKE 'nl@_%' ESCAPE '@';
  IF n > 0 THEN RAISE EXCEPTION 'Quedan % funciones nl_', n; END IF;

  -- Ninguna de las seis puede quedarse con RLS activo y sin política.
  FOREACH t IN ARRAY ARRAY['channels','conversations','messages','customers',
                           'follow_ups','ai_request_logs'] LOOP
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename=t AND policyname='tenant_isolation';
    IF n <> 1 THEN
      RAISE EXCEPTION '% se quedó con RLS activo y sin política legacy', t;
    END IF;
  END LOOP;

  -- Las columnas legacy vuelven a ser obligatorias.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND is_nullable='YES'
     AND ((table_name IN ('channels','conversations','messages','customers',
                          'follow_ups','ai_request_logs') AND column_name='clubId')
       OR (table_name='customers' AND column_name IN ('channelType','externalHandleHash')));
  IF n > 0 THEN RAISE EXCEPTION '% columnas legacy siguen admitiendo NULL', n; END IF;

  RAISE NOTICE 'Rollback completo: esquema legacy restaurado y RLS antiguo activo.';
END $$;

COMMIT;
