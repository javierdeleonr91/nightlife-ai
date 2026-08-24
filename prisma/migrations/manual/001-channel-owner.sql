-- ════════════════════════════════════════════════════════════════════
-- Canales de Instagram y WhatsApp para Club Y Promoter
--
-- Convierte el modelo «todo pertenece a un club» en «todo pertenece a un
-- club O a un promoter», sin perder una sola conversación.
--
-- ADITIVA. No borra ninguna columna. `conversations."clubId"` y sus
-- equivalentes se quedan como LEGACY y se eliminan en otra migración,
-- cuando el código nuevo lleve días funcionando.
--
-- Se ejecuta ENTERA dentro de una transacción. Cualquier comprobación que
-- falle lanza una excepción y deshace todo: no puede quedarse a medias.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f 001-channel-owner.sql
--
-- Usar DIRECT_URL, no DATABASE_URL: el pooler y los DDL largos se llevan mal.
-- Hacer copia de seguridad antes (Supabase → Database → Backups).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── -1. ¿Esta sesión ve todas las filas? ────────────────────────────
-- Comprobación previa a todo, y no es paranoia: si la conexión con la que
-- se lanza la migración está sujeta a RLS, los UPDATE de relleno afectarían
-- a CERO filas **sin dar ningún error**, y las verificaciones del paso 9
-- pasarían sobre una vista vacía. La migración diría «todo bien» y no
-- habría migrado nada.
--
-- Cómo se detecta: con `row_security = off`, Postgres lanza un error si la
-- consulta se vería afectada por alguna política. Un superusuario o un rol
-- con BYPASSRLS no se ve afectado nunca y la consulta pasa; el dueño de la
-- tabla con FORCE, o cualquier rol normal, revienta. Ese es el discriminante.
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
      'El rol % está sujeto a RLS. Con esta conexión los UPDATE de relleno afectarían a 0 filas sin avisar. Usa DIRECT_URL con el rol de migraciones.',
      current_user;
  END IF;
END $$;

-- ── 0. Fotografía del estado inicial ────────────────────────────────
-- Se guarda en una tabla temporal para poder comparar antes de confirmar.
-- Una tabla temporal muere con la sesión: no deja rastro.
CREATE TEMP TABLE _migracion_antes AS
SELECT
  (SELECT count(*) FROM conversations) AS conversaciones,
  (SELECT count(*) FROM messages)      AS mensajes,
  (SELECT count(*) FROM customers)     AS clientes,
  (SELECT count(*) FROM channels)      AS canales;

-- ── 1. Tipos ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChannelOwnerType') THEN
    CREATE TYPE "ChannelOwnerType" AS ENUM ('CLUB', 'PROMOTER');
  END IF;
END $$;

-- ── 2. Columnas nuevas, TODAS nullable de momento ───────────────────
-- Nullable primero es lo que hace que esto sea seguro: la tabla sigue
-- aceptando escrituras del código viejo mientras se rellena.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS "ownerType"       "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "promoterId"      text,
  ADD COLUMN IF NOT EXISTS "displayName"     text,
  ADD COLUMN IF NOT EXISTS "tokenExpiresAt"  timestamptz,
  ADD COLUMN IF NOT EXISTS "autoReply"       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "waMode"          text,
  ADD COLUMN IF NOT EXISTS "lastErrorCode"   text,
  ADD COLUMN IF NOT EXISTS "updatedAt"       timestamptz NOT NULL DEFAULT now();

-- ── 2b. Las columnas LEGACY dejan de ser obligatorias ───────────────
-- Esto lo encontró el ensayo de la migración, no la revisión del código.
--
-- `clubId` se queda como legacy hasta el siguiente despliegue, pero mientras
-- siga siendo NOT NULL **no se puede insertar una conversación de promoter**:
-- habría que inventarle un club, que es justo lo que este cambio viene a
-- eliminar. Se relaja la obligatoriedad sin borrar la columna.
--
-- Relajar un NOT NULL no toca ni una fila: las que hay siguen con su valor.
ALTER TABLE channels        ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE conversations   ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE messages        ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE customers       ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE customers       ALTER COLUMN "channelType" DROP NOT NULL;
ALTER TABLE customers       ALTER COLUMN "externalHandleHash" DROP NOT NULL;
ALTER TABLE follow_ups      ALTER COLUMN "clubId" DROP NOT NULL;
ALTER TABLE ai_request_logs ALTER COLUMN "clubId" DROP NOT NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS "ownerType"        "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "ownerClubId"      text,
  ADD COLUMN IF NOT EXISTS "ownerPromoterId"  text,
  ADD COLUMN IF NOT EXISTS "channelId"        text,
  ADD COLUMN IF NOT EXISTS "externalUserHash" text,
  ADD COLUMN IF NOT EXISTS "externalUserRef"  text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "ownerType"       "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "ownerClubId"     text,
  ADD COLUMN IF NOT EXISTS "ownerPromoterId" text,
  ADD COLUMN IF NOT EXISTS "contextClubId"   text,
  ADD COLUMN IF NOT EXISTS "locale"          text;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS "ownerType"       "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "ownerClubId"     text,
  ADD COLUMN IF NOT EXISTS "ownerPromoterId" text;

ALTER TABLE follow_ups
  ADD COLUMN IF NOT EXISTS "ownerType"       "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "ownerClubId"     text,
  ADD COLUMN IF NOT EXISTS "ownerPromoterId" text;

ALTER TABLE ai_request_logs
  ADD COLUMN IF NOT EXISTS "ownerType"       "ChannelOwnerType",
  ADD COLUMN IF NOT EXISTS "ownerClubId"     text,
  ADD COLUMN IF NOT EXISTS "ownerPromoterId" text;

-- ── 3. Claves foráneas ──────────────────────────────────────────────
-- Antes del backfill: así, si el relleno apuntara a algo que no existe,
-- falla aquí en vez de dejar una relación rota.

-- SEMÁNTICA DE BORRADO — decisión explícita, no la que salga por defecto.
--
-- Borrar un canal NO puede llevarse por delante el historial. Desconectar
-- una integración es la operación normal (CONNECTED → DISCONNECTED); borrar
-- la fila es un accidente, y un accidente no debe destruir conversaciones.
--
-- Por eso channels → customers y channels → conversations son **NO ACTION**.
--
-- NO ACTION y no RESTRICT, y la diferencia importa: NO ACTION se comprueba
-- al FINAL de la sentencia, así que si otro CASCADE de la misma sentencia ya
-- ha borrado las filas hijas, pasa sin quejarse. RESTRICT se comprueba al
-- instante y no da esa oportunidad. Eso es lo que permite que borrar un
-- promoter siga funcionando: sus customers y conversations se van por sus
-- propias FK de propiedad (CASCADE) en la misma sentencia, y para cuando se
-- comprueba el NO ACTION del canal ya no queda nada colgando.
--
-- Resumen:
--   DELETE FROM channels  → falla si tiene historial. Correcto.
--   DELETE FROM promoters → se lleva canales, clientes y conversaciones
--                           suyos. Es su dueño; puede.
--   DELETE FROM clubs     → igual.
DO $$
BEGIN
  -- La FK legacy conversations→channels es ON DELETE SET NULL, que dejaría
  -- de valer en cuanto `channelId` pase a NOT NULL en el paso 10: borrar un
  -- canal intentaría poner NULL y fallaría con un error críptico. Se
  -- sustituye por NO ACTION, sea cual sea el nombre que le pusiera Prisma.
  PERFORM 1;
END $$;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
     WHERE con.contype = 'f'
       AND src.relname = 'conversations'
       AND tgt.relname = 'channels'
       AND con.conname <> 'conversations_channel_fkey'
  LOOP
    EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'Sustituida la FK legacy conversations→channels (%)', c.conname;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_fkey') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_channel_fkey
      FOREIGN KEY ("channelId") REFERENCES channels(id) ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_channel_fkey') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_channel_fkey
      FOREIGN KEY ("channelId") REFERENCES channels(id) ON DELETE NO ACTION;
  END IF;

  -- Propiedad: el dueño sí puede borrar lo suyo.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_promoter_fkey') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_promoter_fkey
      FOREIGN KEY ("promoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_owner_club_fkey') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_owner_club_fkey
      FOREIGN KEY ("ownerClubId") REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_owner_promoter_fkey') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_owner_promoter_fkey
      FOREIGN KEY ("ownerPromoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_owner_club_fkey') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_owner_club_fkey
      FOREIGN KEY ("ownerClubId") REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_owner_promoter_fkey') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_owner_promoter_fkey
      FOREIGN KEY ("ownerPromoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
  -- SetNull y no Cascade: si desaparece el club del que se hablaba, la
  -- conversación del promoter no debe desaparecer con él.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_context_club_fkey') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_context_club_fkey
      FOREIGN KEY ("contextClubId") REFERENCES clubs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_owner_club_fkey') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_owner_club_fkey
      FOREIGN KEY ("ownerClubId") REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_owner_promoter_fkey') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_owner_promoter_fkey
      FOREIGN KEY ("ownerPromoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_ups_owner_club_fkey') THEN
    ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_owner_club_fkey
      FOREIGN KEY ("ownerClubId") REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_ups_owner_promoter_fkey') THEN
    ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_owner_promoter_fkey
      FOREIGN KEY ("ownerPromoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_request_logs_owner_club_fkey') THEN
    ALTER TABLE ai_request_logs ADD CONSTRAINT ai_request_logs_owner_club_fkey
      FOREIGN KEY ("ownerClubId") REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_request_logs_owner_promoter_fkey') THEN
    ALTER TABLE ai_request_logs ADD CONSTRAINT ai_request_logs_owner_promoter_fkey
      FOREIGN KEY ("ownerPromoterId") REFERENCES promoters(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── 4. Canales que faltan para los datos legacy ─────────────────────
-- Hay clientes de clubs que nunca tuvieron fila en `channels`. Sin canal no
-- se les puede enganchar, así que se crean los que falten. Todos son de
-- webchat: es el único canal que ha existido hasta ahora.

INSERT INTO channels (id, "clubId", "ownerType", type, status, "createdAt", "updatedAt")
SELECT
  'ch_legacy_' || md5(c."clubId" || c."channelType"::text),
  c."clubId",
  'CLUB',
  c."channelType",
  'CONNECTED',
  now(),
  now()
FROM (SELECT DISTINCT "clubId", "channelType" FROM customers) c
LEFT JOIN channels ch ON ch."clubId" = c."clubId" AND ch.type = c."channelType"
WHERE ch.id IS NULL;

-- ── 5. Propiedad de los canales ─────────────────────────────────────
-- Todo lo que existe hoy es de un club: no había canales de promoter.
UPDATE channels SET "ownerType" = 'CLUB' WHERE "ownerType" IS NULL;

-- ── 6. Clientes ─────────────────────────────────────────────────────
UPDATE customers cu SET
  "channelId"        = ch.id,
  "ownerType"        = 'CLUB',
  "ownerClubId"      = cu."clubId",
  "externalUserHash" = cu."externalHandleHash"
FROM channels ch
WHERE ch."clubId" = cu."clubId"
  AND ch.type = cu."channelType"
  AND cu."channelId" IS NULL;
-- `externalUserRef` se queda NULL a propósito: son clientes de webchat y no
-- hay ninguna dirección externa a la que responderles.

-- ── 7. Conversaciones ───────────────────────────────────────────────
-- El dueño era el club y sigue siéndolo. `promoterId` marcaba por quién
-- llegó el cliente, no de quién era la conversación: no se toca y no se
-- convierte en dueño.
UPDATE conversations SET
  "ownerType"     = 'CLUB',
  "ownerClubId"   = "clubId",
  "contextClubId" = "clubId"
WHERE "ownerType" IS NULL;

-- Las que no tenían canal se enganchan al de su club.
UPDATE conversations cv SET "channelId" = ch.id
FROM channels ch
WHERE ch."clubId" = cv."clubId"
  AND ch.type = cv."channelType"
  AND cv."channelId" IS NULL;

-- ── 8. Mensajes, seguimientos y registros de IA ─────────────────────
UPDATE messages SET
  "ownerType" = 'CLUB', "ownerClubId" = "clubId"
WHERE "ownerType" IS NULL;

UPDATE follow_ups SET
  "ownerType" = 'CLUB', "ownerClubId" = "clubId"
WHERE "ownerType" IS NULL;

UPDATE ai_request_logs SET
  "ownerType" = 'CLUB', "ownerClubId" = "clubId"
WHERE "ownerType" IS NULL;

-- ── 9. VERIFICACIONES ───────────────────────────────────────────────
-- Si algo de esto no se cumple, la transacción entera se deshace.

DO $$
DECLARE
  antes  record;
  fallo  text;
  n      bigint;
BEGIN
  SELECT * INTO antes FROM _migracion_antes;

  -- 9.1 No se ha perdido ni una fila.
  SELECT count(*) INTO n FROM conversations;
  IF n <> antes.conversaciones THEN
    RAISE EXCEPTION 'Conversaciones: había % y hay %', antes.conversaciones, n;
  END IF;

  SELECT count(*) INTO n FROM messages;
  IF n <> antes.mensajes THEN
    RAISE EXCEPTION 'Mensajes: había % y hay %', antes.mensajes, n;
  END IF;

  SELECT count(*) INTO n FROM customers;
  IF n <> antes.clientes THEN
    RAISE EXCEPTION 'Clientes: había % y hay %', antes.clientes, n;
  END IF;

  -- 9.2 Todo tiene dueño.
  SELECT count(*) INTO n FROM conversations WHERE "ownerType" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% conversaciones sin ownerType', n; END IF;

  SELECT count(*) INTO n FROM messages WHERE "ownerType" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% mensajes sin ownerType', n; END IF;

  SELECT count(*) INTO n FROM customers WHERE "ownerType" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% clientes sin ownerType', n; END IF;

  SELECT count(*) INTO n FROM channels WHERE "ownerType" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% canales sin ownerType', n; END IF;

  -- 9.3 Exactamente un dueño en cada fila.
  SELECT count(*) INTO n FROM conversations
   WHERE ("ownerClubId" IS NULL) = ("ownerPromoterId" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% conversaciones con cero o dos dueños', n; END IF;

  SELECT count(*) INTO n FROM messages
   WHERE ("ownerClubId" IS NULL) = ("ownerPromoterId" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% mensajes con cero o dos dueños', n; END IF;

  SELECT count(*) INTO n FROM customers
   WHERE ("ownerClubId" IS NULL) = ("ownerPromoterId" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% clientes con cero o dos dueños', n; END IF;

  SELECT count(*) INTO n FROM channels
   WHERE ("clubId" IS NULL) = ("promoterId" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% canales con cero o dos dueños', n; END IF;

  -- 9.4 El dueño nuevo coincide con el club viejo. Es la comprobación que
  --     demuestra que no se ha reasignado nada a otro tenant.
  SELECT count(*) INTO n FROM conversations
   WHERE "clubId" IS NOT NULL AND "ownerClubId" IS DISTINCT FROM "clubId";
  IF n > 0 THEN RAISE EXCEPTION '% conversaciones cambiaron de club', n; END IF;

  SELECT count(*) INTO n FROM messages
   WHERE "clubId" IS NOT NULL AND "ownerClubId" IS DISTINCT FROM "clubId";
  IF n > 0 THEN RAISE EXCEPTION '% mensajes cambiaron de club', n; END IF;

  -- 9.5 Ningún cliente ni conversación se ha quedado sin canal.
  SELECT count(*) INTO n FROM customers WHERE "channelId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% clientes sin canal', n; END IF;

  SELECT count(*) INTO n FROM conversations WHERE "channelId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% conversaciones sin canal', n; END IF;

  -- 9.6 El dueño del cliente coincide con el dueño de su canal.
  SELECT count(*) INTO n FROM customers cu
    JOIN channels ch ON ch.id = cu."channelId"
   WHERE cu."ownerClubId" IS DISTINCT FROM ch."clubId"
      OR cu."ownerPromoterId" IS DISTINCT FROM ch."promoterId";
  IF n > 0 THEN RAISE EXCEPTION '% clientes con dueño distinto al de su canal', n; END IF;

  -- 9.7 El dueño del mensaje coincide con el de su conversación.
  SELECT count(*) INTO n FROM messages m
    JOIN conversations cv ON cv.id = m."conversationId"
   WHERE m."ownerType"       IS DISTINCT FROM cv."ownerType"
      OR m."ownerClubId"     IS DISTINCT FROM cv."ownerClubId"
      OR m."ownerPromoterId" IS DISTINCT FROM cv."ownerPromoterId";
  IF n > 0 THEN RAISE EXCEPTION '% mensajes con dueño distinto al de su conversación', n; END IF;

  -- 9.8 Ningún externalAccountId repetido dentro del mismo tipo.
  SELECT count(*) INTO n FROM (
    SELECT type, "externalAccountId"
      FROM channels
     WHERE "externalAccountId" IS NOT NULL
     GROUP BY type, "externalAccountId"
    HAVING count(*) > 1
  ) d;
  IF n > 0 THEN RAISE EXCEPTION '% cuentas externas duplicadas en el mismo tipo', n; END IF;

  -- 9.9 Ningún hash de cliente repetido dentro del mismo canal.
  SELECT count(*) INTO n FROM (
    SELECT "channelId", "externalUserHash"
      FROM customers
     GROUP BY "channelId", "externalUserHash"
    HAVING count(*) > 1
  ) d;
  IF n > 0 THEN RAISE EXCEPTION '% clientes duplicados en el mismo canal', n; END IF;

  RAISE NOTICE 'Verificaciones superadas: % conversaciones, % mensajes, % clientes',
    antes.conversaciones, antes.mensajes, antes.clientes;
END $$;

-- ── 10. Ahora sí: obligatorios y CHECKs ─────────────────────────────
-- Solo después de comprobar que los datos ya los cumplen.

ALTER TABLE channels      ALTER COLUMN "ownerType" SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN "ownerType" SET NOT NULL;
ALTER TABLE messages      ALTER COLUMN "ownerType" SET NOT NULL;
ALTER TABLE customers     ALTER COLUMN "ownerType" SET NOT NULL;
ALTER TABLE follow_ups    ALTER COLUMN "ownerType" SET NOT NULL;
ALTER TABLE ai_request_logs ALTER COLUMN "ownerType" SET NOT NULL;

ALTER TABLE customers     ALTER COLUMN "channelId" SET NOT NULL;
ALTER TABLE customers     ALTER COLUMN "externalUserHash" SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN "channelId" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_one_owner') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "clubId" IS NOT NULL AND "promoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "promoterId" IS NOT NULL AND "clubId" IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_one_owner') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_one_owner') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_one_owner') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_ups_one_owner') THEN
    ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_request_logs_one_owner') THEN
    ALTER TABLE ai_request_logs ADD CONSTRAINT ai_request_logs_one_owner CHECK (
      ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
      ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
    );
  END IF;

  -- El tipo de dueño de un mensaje no puede divergir del de su conversación.
  -- Es lo máximo que puede garantizar la base de datos por sí sola: una FK
  -- compuesta sobre columnas nullable usa MATCH SIMPLE y se saltaría la
  -- comprobación en cuanto una fuera NULL. El id concreto lo vigilan la
  -- aplicación (deriva el dueño de la conversación, nunca de la petición) y
  -- la consulta 9.7, que se puede repasar periódicamente.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_id_owner_type_key') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_id_owner_type_key
      UNIQUE (id, "ownerType");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_conversation_owner_fkey') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_conversation_owner_fkey
      FOREIGN KEY ("conversationId", "ownerType")
      REFERENCES conversations (id, "ownerType") ON DELETE CASCADE;
  END IF;
END $$;

-- ── 11. Índices y unicidad ──────────────────────────────────────────
-- NOTA sobre NULL: en PostgreSQL un índice UNIQUE trata cada NULL como
-- distinto (NULLS DISTINCT es el comportamiento por defecto). Por eso varios
-- canales DESCONECTADOS, todos con externalAccountId NULL, conviven sin
-- chocar. Es justo lo que se necesita: la unicidad solo debe aplicar a las
-- cuentas realmente conectadas.

CREATE UNIQUE INDEX IF NOT EXISTS channels_type_external_key
  ON channels (type, "externalAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS channels_promoter_type_key
  ON channels ("promoterId", type);
CREATE INDEX IF NOT EXISTS channels_owner_status_idx
  ON channels ("ownerType", status);

CREATE UNIQUE INDEX IF NOT EXISTS customers_channel_hash_key
  ON customers ("channelId", "externalUserHash");
CREATE INDEX IF NOT EXISTS customers_owner_club_idx     ON customers ("ownerClubId");
CREATE INDEX IF NOT EXISTS customers_owner_promoter_idx ON customers ("ownerPromoterId");

CREATE INDEX IF NOT EXISTS conversations_owner_club_status_idx
  ON conversations ("ownerClubId", status);
CREATE INDEX IF NOT EXISTS conversations_owner_club_last_idx
  ON conversations ("ownerClubId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS conversations_owner_promoter_status_idx
  ON conversations ("ownerPromoterId", status);
CREATE INDEX IF NOT EXISTS conversations_owner_promoter_last_idx
  ON conversations ("ownerPromoterId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS conversations_context_club_idx
  ON conversations ("contextClubId");

CREATE INDEX IF NOT EXISTS messages_owner_club_idx     ON messages ("ownerClubId");
CREATE INDEX IF NOT EXISTS messages_owner_promoter_idx ON messages ("ownerPromoterId");

-- ── 12. Triggers: la cadena de propiedad la garantiza la base ───────
--
-- Por qué no basta con la aplicación: `ownerClubId` y `ownerPromoterId`
-- participan **directamente en RLS**. Una fila que acabe con el dueño de
-- otro no es un dato mal puesto: es una fuga de aislamiento entre
-- inquilinos. Eso no puede depender de que ningún código se acuerde.
--
-- REGLA: vacío → derivar. Igual → aceptar. Distinto → RECHAZAR.
--
-- Las tres opciones y por qué esta:
--
--  · Derivar siempre (sobrescribir en silencio) — imposible de romper, pero
--    se traga los errores: un fallo del código que mande el owner
--    equivocado nunca se ve, y un intento malicioso tampoco deja rastro.
--  · Rechazar siempre — ruidoso, pero obliga a cada llamante a calcular el
--    owner correctamente, y el día que alguien añada una ruta que se olvide,
--    falla en producción.
--  · **Derivar cuando falta, rechazar cuando difiere** — nunca queda mal, y
--    cuando algo intenta poner un owner que no toca, se entera todo el
--    mundo. Es la única que no puede fallar en abierto ni callarse un fallo.
--
-- Aceptar el owner correcto cuando viene explícito no es un detalle menor:
-- Prisma manda en el UPDATE **todos** los campos del objeto, no solo los que
-- cambiaron. Si reescribir el mismo owner fallara, cualquier
-- `conversation.update()` normal reventaría en producción.
--
-- Todos son BEFORE: corrigen o abortan antes de escribir nada.
--
-- Ninguna función es SECURITY DEFINER, y es deliberado: así sus SELECT
-- internos pasan también por RLS. Un promoter que intente colgar un mensaje
-- de una conversación ajena no recibe «no es tuya» sino «no existe», que es
-- la respuesta correcta porque para él no existe.

-- ── 12.1 Derivación desde el canal ──────────────────────────────────

CREATE OR REPLACE FUNCTION nl_customer_owner() RETURNS trigger AS $fn$
DECLARE ch record;
BEGIN
  SELECT "ownerType", "clubId", "promoterId" INTO ch
    FROM channels WHERE id = NEW."channelId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer %: el canal % no existe', NEW.id, NEW."channelId";
  END IF;

  IF NEW."ownerType" IS NULL THEN
    NEW."ownerType"       := ch."ownerType";
    NEW."ownerClubId"     := ch."clubId";
    NEW."ownerPromoterId" := ch."promoterId";
  ELSIF NEW."ownerType"       IS DISTINCT FROM ch."ownerType"
     OR NEW."ownerClubId"     IS DISTINCT FROM ch."clubId"
     OR NEW."ownerPromoterId" IS DISTINCT FROM ch."promoterId" THEN
    RAISE EXCEPTION
      'Customer %: el dueño (% / % / %) no es el del canal % (% / % / %)',
      NEW.id, NEW."ownerType", NEW."ownerClubId", NEW."ownerPromoterId",
      NEW."channelId", ch."ownerType", ch."clubId", ch."promoterId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nl_conversation_owner() RETURNS trigger AS $fn$
DECLARE ch record;
BEGIN
  SELECT "ownerType", "clubId", "promoterId" INTO ch
    FROM channels WHERE id = NEW."channelId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation %: el canal % no existe', NEW.id, NEW."channelId";
  END IF;

  IF NEW."ownerType" IS NULL THEN
    NEW."ownerType"       := ch."ownerType";
    NEW."ownerClubId"     := ch."clubId";
    NEW."ownerPromoterId" := ch."promoterId";
  ELSIF NEW."ownerType"       IS DISTINCT FROM ch."ownerType"
     OR NEW."ownerClubId"     IS DISTINCT FROM ch."clubId"
     OR NEW."ownerPromoterId" IS DISTINCT FROM ch."promoterId" THEN
    RAISE EXCEPTION
      'Conversation %: el dueño (% / % / %) no es el del canal % (% / % / %)',
      NEW.id, NEW."ownerType", NEW."ownerClubId", NEW."ownerPromoterId",
      NEW."channelId", ch."ownerType", ch."clubId", ch."promoterId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── 12.2 Derivación desde la conversación ───────────────────────────
-- Message, FollowUp y AiRequestLog comparten la lógica. Se escribe una vez
-- y TG_TABLE_NAME pone el nombre en el mensaje de error: tres copias de lo
-- mismo son tres sitios donde arreglar el próximo fallo.
--
-- `conversationId` es NOT NULL en messages y follow_ups, y nullable en
-- ai_request_logs. Ese es el único caso en que no hay de dónde derivar: un
-- registro de IA sin conversación (por ejemplo, una consulta suelta) lleva
-- el owner del contexto de servidor, y entonces tiene que venir puesto.

CREATE OR REPLACE FUNCTION nl_child_owner_from_conversation() RETURNS trigger AS $fn$
DECLARE cv record;
BEGIN
  IF NEW."conversationId" IS NULL THEN
    IF NEW."ownerType" IS NULL THEN
      RAISE EXCEPTION
        '%(%): sin conversationId no hay de dónde derivar el dueño; hay que fijarlo desde el contexto del servidor',
        TG_TABLE_NAME, NEW.id;
    END IF;
    RETURN NEW;   -- el CHECK ..._one_owner comprueba que sea coherente
  END IF;

  SELECT "ownerType", "ownerClubId", "ownerPromoterId" INTO cv
    FROM conversations WHERE id = NEW."conversationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION '%(%): la conversación % no existe',
      TG_TABLE_NAME, NEW.id, NEW."conversationId";
  END IF;

  IF NEW."ownerType" IS NULL THEN
    NEW."ownerType"       := cv."ownerType";
    NEW."ownerClubId"     := cv."ownerClubId";
    NEW."ownerPromoterId" := cv."ownerPromoterId";
  ELSIF NEW."ownerType"       IS DISTINCT FROM cv."ownerType"
     OR NEW."ownerClubId"     IS DISTINCT FROM cv."ownerClubId"
     OR NEW."ownerPromoterId" IS DISTINCT FROM cv."ownerPromoterId" THEN
    RAISE EXCEPTION
      '%(%): el dueño (% / % / %) no es el de la conversación % (% / % / %)',
      TG_TABLE_NAME, NEW.id,
      NEW."ownerType", NEW."ownerClubId", NEW."ownerPromoterId",
      NEW."conversationId", cv."ownerType", cv."ownerClubId", cv."ownerPromoterId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── 12.3 Inmutabilidad ──────────────────────────────────────────────
-- El dueño se fija al crear y no se mueve. No hay ningún flujo legítimo que
-- cambie de dueño una conversación: un DM que llegó al Instagram de Javier
-- es de Javier para siempre. Si el canal cambia de manos, se desconecta y se
-- vuelve a conectar, que crea filas nuevas.
--
-- Los punteros al padre (`channelId`, `conversationId`) también se congelan:
-- cambiarlos cambiaría el dueño por la puerta de atrás, saltándose la
-- comprobación de 12.1 y 12.2.
--
-- `contextClubId` NO está aquí, a propósito: es «de qué se habla», no «de
-- quién es», y una conversación puede pasar de preguntar por un club a
-- preguntar por otro. No concede acceso a nada (ver rls-owner.sql).

CREATE OR REPLACE FUNCTION nl_owner_immutable() RETURNS trigger AS $fn$
BEGIN
  IF NEW."ownerType"       IS DISTINCT FROM OLD."ownerType"
  OR NEW."ownerClubId"     IS DISTINCT FROM OLD."ownerClubId"
  OR NEW."ownerPromoterId" IS DISTINCT FROM OLD."ownerPromoterId" THEN
    RAISE EXCEPTION
      '%(%): el dueño no se puede cambiar (% / % / % → % / % / %)',
      TG_TABLE_NAME, OLD.id,
      OLD."ownerType", OLD."ownerClubId", OLD."ownerPromoterId",
      NEW."ownerType", NEW."ownerClubId", NEW."ownerPromoterId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- Channels guarda el dueño en otras columnas (clubId/promoterId), así que
-- necesita su propia versión.
CREATE OR REPLACE FUNCTION nl_channel_owner_immutable() RETURNS trigger AS $fn$
BEGIN
  IF NEW."ownerType"  IS DISTINCT FROM OLD."ownerType"
  OR NEW."clubId"     IS DISTINCT FROM OLD."clubId"
  OR NEW."promoterId" IS DISTINCT FROM OLD."promoterId" THEN
    RAISE EXCEPTION
      'channels(%): el dueño de un canal no se puede cambiar (% / % / % → % / % / %). Para cambiar de manos: desconectar y volver a conectar.',
      OLD.id,
      OLD."ownerType", OLD."clubId", OLD."promoterId",
      NEW."ownerType", NEW."clubId", NEW."promoterId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nl_channel_ref_immutable() RETURNS trigger AS $fn$
BEGIN
  IF NEW."channelId" IS DISTINCT FROM OLD."channelId" THEN
    RAISE EXCEPTION
      '%(%): el canal no se puede cambiar (% → %). Cambiarlo cambiaría el dueño.',
      TG_TABLE_NAME, OLD.id, OLD."channelId", NEW."channelId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nl_conversation_ref_immutable() RETURNS trigger AS $fn$
BEGIN
  IF NEW."conversationId" IS DISTINCT FROM OLD."conversationId" THEN
    RAISE EXCEPTION
      '%(%): la conversación no se puede cambiar (% → %). Cambiarla cambiaría el dueño.',
      TG_TABLE_NAME, OLD.id,
      coalesce(OLD."conversationId", '<NULL>'), coalesce(NEW."conversationId", '<NULL>');
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── 12.4 Los triggers ───────────────────────────────────────────────
-- Nombres en orden alfabético dentro de cada tabla: PostgreSQL dispara los
-- BEFORE por nombre, así que `nl_x_immutable_t` va antes que `nl_x_owner_t`
-- y un intento de mover el dueño se rechaza antes de intentar derivarlo.

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

-- channels: el dueño es inmutable. No hay derivación: es la raíz.
CREATE TRIGGER nl_channel_immutable_t
  BEFORE UPDATE ON channels FOR EACH ROW
  EXECUTE FUNCTION nl_channel_owner_immutable();

-- customers ← channel
CREATE TRIGGER nl_customer_channel_t
  BEFORE UPDATE ON customers FOR EACH ROW
  EXECUTE FUNCTION nl_channel_ref_immutable();
CREATE TRIGGER nl_customer_immutable_t
  BEFORE UPDATE ON customers FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_customer_owner_t
  BEFORE INSERT OR UPDATE OF "channelId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON customers FOR EACH ROW EXECUTE FUNCTION nl_customer_owner();

-- conversations ← channel
CREATE TRIGGER nl_conversation_channel_t
  BEFORE UPDATE ON conversations FOR EACH ROW
  EXECUTE FUNCTION nl_channel_ref_immutable();
CREATE TRIGGER nl_conversation_immutable_t
  BEFORE UPDATE ON conversations FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_conversation_owner_t
  BEFORE INSERT OR UPDATE OF "channelId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON conversations FOR EACH ROW EXECUTE FUNCTION nl_conversation_owner();

-- messages ← conversation
CREATE TRIGGER nl_message_conversation_t
  BEFORE UPDATE ON messages FOR EACH ROW
  EXECUTE FUNCTION nl_conversation_ref_immutable();
CREATE TRIGGER nl_message_immutable_t
  BEFORE UPDATE ON messages FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_message_owner_t
  BEFORE INSERT OR UPDATE OF "conversationId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON messages FOR EACH ROW EXECUTE FUNCTION nl_child_owner_from_conversation();

-- follow_ups ← conversation
CREATE TRIGGER nl_followup_conversation_t
  BEFORE UPDATE ON follow_ups FOR EACH ROW
  EXECUTE FUNCTION nl_conversation_ref_immutable();
CREATE TRIGGER nl_followup_immutable_t
  BEFORE UPDATE ON follow_ups FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_followup_owner_t
  BEFORE INSERT OR UPDATE OF "conversationId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON follow_ups FOR EACH ROW EXECUTE FUNCTION nl_child_owner_from_conversation();

-- ai_request_logs ← conversation (nullable)
CREATE TRIGGER nl_ailog_conversation_t
  BEFORE UPDATE ON ai_request_logs FOR EACH ROW
  EXECUTE FUNCTION nl_conversation_ref_immutable();
CREATE TRIGGER nl_ailog_immutable_t
  BEFORE UPDATE ON ai_request_logs FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_ailog_owner_t
  BEFORE INSERT OR UPDATE OF "conversationId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON ai_request_logs FOR EACH ROW EXECUTE FUNCTION nl_child_owner_from_conversation();

COMMIT;
