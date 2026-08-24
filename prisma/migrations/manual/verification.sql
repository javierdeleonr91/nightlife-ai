-- ════════════════════════════════════════════════════════════════════
-- verification.sql — ¿quedó bien la migración?
--
-- Solo lee. No modifica nada. Conviene ejecutarlo justo después de 001 +
-- app-role + rls-owner, y otra vez unos días más tarde: algunas cosas solo
-- se rompen cuando el código nuevo lleva un rato escribiendo.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--        -f prisma/migrations/manual/verification.sql
--
-- Cada línea imprime OK, AVISO o FALLA. Al final, si hay algún FALLA, lanza
-- una excepción: con -v ON_ERROR_STOP=1 el proceso termina con código
-- distinto de cero y se puede encadenar en un despliegue.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET client_min_messages = notice;

DO $$
DECLARE
  fallos int := 0;
  n      bigint;
  txt    text;
  r      record;
  t      text;

  -- Listas EXACTAS de lo que debe existir. Contar con LIKE 'nl_%' no vale:
  -- en SQL el `_` es un comodín, así que `nl_%` casa con `nlikesel`, una
  -- función interna de PostgreSQL. Ese fallo me costó un rato; de ahí las
  -- listas explícitas.
  triggers_esperados text[] := ARRAY[
    'nl_channel_immutable_t',
    'nl_customer_channel_t', 'nl_customer_immutable_t', 'nl_customer_owner_t',
    'nl_conversation_channel_t', 'nl_conversation_immutable_t', 'nl_conversation_owner_t',
    'nl_message_conversation_t', 'nl_message_immutable_t', 'nl_message_owner_t',
    'nl_followup_conversation_t', 'nl_followup_immutable_t', 'nl_followup_owner_t',
    'nl_ailog_conversation_t', 'nl_ailog_immutable_t', 'nl_ailog_owner_t'
  ];
  funciones_esperadas text[] := ARRAY[
    'nl_customer_owner', 'nl_conversation_owner', 'nl_child_owner_from_conversation',
    'nl_owner_immutable', 'nl_channel_owner_immutable',
    'nl_channel_ref_immutable', 'nl_conversation_ref_immutable'
  ];
  tablas_owner text[] := ARRAY[
    'channels','conversations','messages','customers','follow_ups','ai_request_logs'
  ];
  /* La migración 010 es posterior y opcional: puede no haberse aplicado
     todavía. Lo que trae se añade a las listas esperadas solo si sus tablas
     existen, para que este informe valga en los dos estados sin relajar
     ningún recuento. */
  hay_010 boolean := EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='unanswered_questions'
  );
BEGIN

IF hay_010 THEN
  triggers_esperados := triggers_esperados || ARRAY[
    'nl_unanswered_conversation_t', 'nl_unanswered_immutable_t',
    'nl_unanswered_owner_t', 'nl_feedback_immutable_t'
  ];
  RAISE NOTICE 'AVISO  · migración 010 detectada: se comprueban también sus tablas';
ELSE
  RAISE NOTICE 'AVISO  · migración 010 no aplicada todavía';
END IF;

-- ════ 0. Esta sesión no puede estar filtrada ════════════════════════
-- Lo primero, y lo más importante de todo el archivo. Si la conexión está
-- sujeta a RLS, todas las comprobaciones de datos de más abajo consultarían
-- una vista vacía y dirían «0 huérfanos, 0 divergencias, todo perfecto».
-- Un informe en verde sobre nada.
--
-- Detección: con `row_security = off`, Postgres lanza un error si la
-- consulta se vería afectada por alguna política. Superusuario o BYPASSRLS
-- pasan; el dueño de la tabla con FORCE, o cualquier rol normal, revientan.
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
      'El rol % está sujeto a RLS: este informe saldría verde sobre una vista vacía. Ejecuta con DIRECT_URL.',
      current_user;
  END IF;
  RAISE NOTICE 'OK     · la sesión (%) ve todas las filas', current_user;
END;

-- ════ A. Estructura ═════════════════════════════════════════════════
RAISE NOTICE '── A. Estructura ──────────────────────────────────';

SELECT count(*) INTO n FROM pg_type WHERE typname = 'ChannelOwnerType';
IF n = 1 THEN RAISE NOTICE 'OK     · el tipo ChannelOwnerType existe';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · falta el tipo ChannelOwnerType'; END IF;

SELECT count(*) INTO n FROM information_schema.columns
 WHERE table_schema='public' AND column_name='ownerType' AND table_name = ANY(tablas_owner);
IF n = 6 THEN RAISE NOTICE 'OK     · las 6 tablas tienen ownerType';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · solo % de 6 tablas tienen ownerType', n; END IF;

SELECT count(*) INTO n FROM information_schema.columns
 WHERE table_schema='public' AND is_nullable='YES' AND column_name='ownerType'
   AND table_name = ANY(tablas_owner);
IF n = 0 THEN RAISE NOTICE 'OK     · ownerType es obligatorio en todas';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % tablas admiten ownerType nulo', n; END IF;

-- 6 de la migración 001, más 2 de la 010 si está aplicada.
DECLARE esperados_check int := CASE WHEN hay_010 THEN 8 ELSE 6 END;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint WHERE conname LIKE '%@_one@_owner' ESCAPE '@';
  IF n = esperados_check THEN
    RAISE NOTICE 'OK     · los % CHECK de dueño único están puestos', esperados_check;
  ELSE fallos := fallos+1;
    RAISE NOTICE 'FALLA  · hay % CHECK de dueño único, esperaba %', n, esperados_check;
  END IF;
END;

SELECT count(*) INTO n FROM pg_constraint WHERE conname = 'messages_conversation_owner_fkey';
IF n = 1 THEN RAISE NOTICE 'OK     · la FK compuesta mensaje→conversación existe';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · falta messages_conversation_owner_fkey'; END IF;

-- externalAccountId único por tipo, solo cuando no es NULL. En PostgreSQL un
-- índice UNIQUE trata cada NULL como distinto, así que varios canales
-- DESCONECTADOS (todos con NULL) conviven sin chocar. Es lo que se quiere.
SELECT count(*) INTO n FROM pg_indexes
 WHERE schemaname='public' AND indexname='channels_type_external_key';
IF n = 1 THEN RAISE NOTICE 'OK     · índice único (type, externalAccountId)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · falta channels_type_external_key'; END IF;

-- ════ B. Semántica de borrado del canal ═════════════════════════════
RAISE NOTICE '── B. Borrado de canal ────────────────────────────';

-- Borrar un canal no puede llevarse el historial por delante. Las dos FK
-- que apuntan al canal deben ser 'a' (NO ACTION) o 'r' (RESTRICT), nunca
-- 'c' (CASCADE) ni 'n' (SET NULL).
FOR r IN
  SELECT con.conname, con.confdeltype, src.relname AS tabla
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype='f' AND tgt.relname='channels'
     AND src.relname IN ('customers','conversations')
LOOP
  IF r.confdeltype IN ('a','r') THEN
    RAISE NOTICE 'OK     · %→channels preserva el historial (%)', r.tabla,
      CASE r.confdeltype WHEN 'a' THEN 'NO ACTION' ELSE 'RESTRICT' END;
  ELSE
    fallos := fallos+1;
    RAISE NOTICE 'FALLA  · %→channels es %: borrar un canal destruiría datos',
      r.tabla, CASE r.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                                  WHEN 'd' THEN 'SET DEFAULT' ELSE r.confdeltype::text END;
  END IF;
END LOOP;

SELECT count(*) INTO n FROM pg_constraint con
  JOIN pg_class src ON src.oid=con.conrelid JOIN pg_class tgt ON tgt.oid=con.confrelid
 WHERE con.contype='f' AND tgt.relname='channels'
   AND src.relname IN ('customers','conversations');
IF n = 2 THEN RAISE NOTICE 'OK     · las dos FK hacia channels existen';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · hay % FK hacia channels, esperaba 2', n; END IF;

-- El dueño sí puede borrar lo suyo: esas FK deben ser CASCADE.
SELECT count(*) INTO n FROM pg_constraint
 WHERE contype='f' AND confdeltype='c'
   AND conname IN ('customers_owner_club_fkey','customers_owner_promoter_fkey',
                   'conversations_owner_club_fkey','conversations_owner_promoter_fkey',
                   'messages_owner_club_fkey','messages_owner_promoter_fkey',
                   'follow_ups_owner_club_fkey','follow_ups_owner_promoter_fkey',
                   'ai_request_logs_owner_club_fkey','ai_request_logs_owner_promoter_fkey',
                   'channels_promoter_fkey');
IF n = 11 THEN RAISE NOTICE 'OK     · las 11 FK de propiedad son CASCADE (el dueño borra lo suyo)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · solo % de 11 FK de propiedad son CASCADE', n; END IF;

-- contextClubId es SET NULL: si desaparece el club del que se hablaba, la
-- conversación del RRPP no se va con él.
SELECT confdeltype INTO txt FROM pg_constraint WHERE conname='conversations_context_club_fkey';
IF txt = 'n' THEN RAISE NOTICE 'OK     · contextClubId es SET NULL, no arrastra la conversación';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · conversations_context_club_fkey es %', coalesce(txt,'inexistente'); END IF;

-- ════ C. Triggers y funciones (listas exactas) ══════════════════════
RAISE NOTICE '── C. Triggers ────────────────────────────────────';

FOREACH t IN ARRAY triggers_esperados LOOP
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = t AND NOT tgisinternal;
  IF n = 0 THEN fallos := fallos+1; RAISE NOTICE 'FALLA  · falta el trigger %', t; END IF;
END LOOP;
SELECT count(*) INTO n FROM pg_trigger WHERE tgname = ANY(triggers_esperados) AND NOT tgisinternal;
IF n = array_length(triggers_esperados,1) THEN
  RAISE NOTICE 'OK     · los % triggers esperados existen', n;
END IF;

-- Ninguno de más: un trigger nl_ que no esté en la lista es algo que nadie
-- ha revisado.
SELECT string_agg(tgname, ', ') INTO txt FROM pg_trigger
 WHERE NOT tgisinternal AND tgname LIKE 'nl@_%' ESCAPE '@'
   AND NOT (tgname = ANY(triggers_esperados));
IF txt IS NULL THEN RAISE NOTICE 'OK     · no hay triggers nl_ inesperados';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · triggers nl_ no esperados: %', txt; END IF;

-- Un trigger deshabilitado sigue en pg_trigger. Hay que mirar tgenabled:
-- 'O' = activo en modo normal. Cualquier otra cosa es un trigger de adorno.
SELECT string_agg(tgname, ', ') INTO txt FROM pg_trigger
 WHERE tgname = ANY(triggers_esperados) AND NOT tgisinternal AND tgenabled <> 'O';
IF txt IS NULL THEN RAISE NOTICE 'OK     · ninguno está deshabilitado';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · deshabilitados: % (ALTER TABLE ... ENABLE TRIGGER)', txt; END IF;

-- Todos BEFORE: tgtype bit 1 = BEFORE.
SELECT string_agg(tgname, ', ') INTO txt FROM pg_trigger
 WHERE tgname = ANY(triggers_esperados) AND NOT tgisinternal AND (tgtype & 2) = 0;
IF txt IS NULL THEN RAISE NOTICE 'OK     · todos son BEFORE (corrigen o abortan antes de escribir)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · no son BEFORE: %', txt; END IF;

FOREACH t IN ARRAY funciones_esperadas LOOP
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname = t;
  IF n = 0 THEN fallos := fallos+1; RAISE NOTICE 'FALLA  · falta la función %', t; END IF;
END LOOP;
SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
 WHERE ns.nspname='public' AND p.proname = ANY(funciones_esperadas);
IF n = array_length(funciones_esperadas,1) THEN
  RAISE NOTICE 'OK     · las % funciones esperadas existen', n;
END IF;

-- SECURITY DEFINER en estas funciones sería un agujero: sus SELECT internos
-- dejarían de pasar por RLS.
SELECT string_agg(proname, ', ') INTO txt FROM pg_proc
 WHERE proname = ANY(funciones_esperadas) AND prosecdef;
IF txt IS NULL THEN RAISE NOTICE 'OK     · ninguna es SECURITY DEFINER';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · SECURITY DEFINER: %', txt; END IF;

-- ════ D. Coherencia de la cadena de propiedad ═══════════════════════
RAISE NOTICE '── D. Datos ───────────────────────────────────────';

-- Channel: dueño válido y exactamente uno.
SELECT count(*) INTO n FROM channels
 WHERE NOT (("ownerType"='CLUB'     AND "clubId" IS NOT NULL AND "promoterId" IS NULL)
         OR ("ownerType"='PROMOTER' AND "promoterId" IS NOT NULL AND "clubId" IS NULL));
IF n = 0 THEN RAISE NOTICE 'OK     · todos los canales tienen exactamente un dueño válido';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % canales con dueño inválido', n; END IF;

-- Las otras cinco: cero o dos dueños es igual de malo.
FOREACH t IN ARRAY ARRAY['conversations','messages','customers','follow_ups','ai_request_logs'] LOOP
  EXECUTE format($q$
    SELECT count(*) FROM %I
     WHERE NOT (("ownerType"='CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL)
             OR ("ownerType"='PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL))
  $q$, t) INTO n;
  IF n > 0 THEN fallos := fallos+1;
    RAISE NOTICE 'FALLA  · % filas de % con cero o dos dueños', n, t; END IF;
END LOOP;
RAISE NOTICE 'OK     · comprobado «exactamente un dueño» en las 6 tablas';

SELECT count(*) INTO n FROM customers cu JOIN channels ch ON ch.id = cu."channelId"
 WHERE cu."ownerType" IS DISTINCT FROM ch."ownerType"
    OR cu."ownerClubId" IS DISTINCT FROM ch."clubId"
    OR cu."ownerPromoterId" IS DISTINCT FROM ch."promoterId";
IF n = 0 THEN RAISE NOTICE 'OK     · Customer.owner == Channel.owner';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % clientes discrepan de su canal', n; END IF;

SELECT count(*) INTO n FROM conversations cv JOIN channels ch ON ch.id = cv."channelId"
 WHERE cv."ownerType" IS DISTINCT FROM ch."ownerType"
    OR cv."ownerClubId" IS DISTINCT FROM ch."clubId"
    OR cv."ownerPromoterId" IS DISTINCT FROM ch."promoterId";
IF n = 0 THEN RAISE NOTICE 'OK     · Conversation.owner == Channel.owner';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % conversaciones discrepan de su canal', n; END IF;

SELECT count(*) INTO n FROM messages ms JOIN conversations cv ON cv.id = ms."conversationId"
 WHERE ms."ownerType" IS DISTINCT FROM cv."ownerType"
    OR ms."ownerClubId" IS DISTINCT FROM cv."ownerClubId"
    OR ms."ownerPromoterId" IS DISTINCT FROM cv."ownerPromoterId";
IF n = 0 THEN RAISE NOTICE 'OK     · Message.owner == Conversation.owner';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % mensajes discrepan de su conversación', n; END IF;

SELECT count(*) INTO n FROM follow_ups fu JOIN conversations cv ON cv.id = fu."conversationId"
 WHERE fu."ownerType" IS DISTINCT FROM cv."ownerType"
    OR fu."ownerClubId" IS DISTINCT FROM cv."ownerClubId"
    OR fu."ownerPromoterId" IS DISTINCT FROM cv."ownerPromoterId";
IF n = 0 THEN RAISE NOTICE 'OK     · FollowUp.owner == Conversation.owner';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % follow-ups discrepan de su conversación', n; END IF;

-- AiRequestLog solo cuando tiene conversación; sin ella lleva el owner del
-- contexto de servidor y no hay con qué compararlo.
SELECT count(*) INTO n FROM ai_request_logs al JOIN conversations cv ON cv.id = al."conversationId"
 WHERE al."ownerType" IS DISTINCT FROM cv."ownerType"
    OR al."ownerClubId" IS DISTINCT FROM cv."ownerClubId"
    OR al."ownerPromoterId" IS DISTINCT FROM cv."ownerPromoterId";
IF n = 0 THEN RAISE NOTICE 'OK     · AiRequestLog.owner == Conversation.owner (cuando hay conversación)';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % registros de IA discrepan de su conversación', n; END IF;

-- Huérfanos: el dueño apunta a algo que ya no existe. Con las FK puestas no
-- debería pasar nunca; se comprueba porque una FK puede llegar NOT VALID.
FOREACH t IN ARRAY ARRAY['conversations','messages','customers','follow_ups','ai_request_logs'] LOOP
  EXECUTE format($q$
    SELECT count(*) FROM %I x
     WHERE (x."ownerClubId" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id = x."ownerClubId"))
        OR (x."ownerPromoterId" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id = x."ownerPromoterId"))
  $q$, t) INTO n;
  IF n > 0 THEN fallos := fallos+1; RAISE NOTICE 'FALLA  · % huérfanos en %', n, t; END IF;
END LOOP;
SELECT count(*) INTO n FROM channels ch
 WHERE (ch."clubId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id=ch."clubId"))
    OR (ch."promoterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=ch."promoterId"));
IF n > 0 THEN fallos := fallos+1; RAISE NOTICE 'FALLA  · % canales huérfanos', n; END IF;
RAISE NOTICE 'OK     · ningún huérfano en las 6 tablas';

-- Legacy coherente: mientras `clubId` siga existiendo debe cuadrar.
SELECT count(*) INTO n FROM conversations
 WHERE "ownerType"='CLUB' AND "clubId" IS DISTINCT FROM "ownerClubId";
IF n = 0 THEN RAISE NOTICE 'OK     · el clubId legacy coincide con el dueño';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · % conversaciones con clubId legacy descuadrado', n; END IF;

SELECT count(*) INTO n FROM conversations WHERE "ownerType"='PROMOTER' AND "clubId" IS NOT NULL;
IF n = 0 THEN RAISE NOTICE 'OK     · ninguna conversación de RRPP arrastra clubId legacy';
ELSE RAISE NOTICE 'AVISO  · % conversaciones de RRPP con clubId legacy (revisar antes de la 002)', n; END IF;

-- ════ E. Inmutabilidad, comprobada de verdad ════════════════════════
-- Que el trigger exista no prueba que funcione. Se intenta la operación
-- prohibida dentro de una subtransacción y se deshace: no queda rastro.
RAISE NOTICE '── E. Inmutabilidad (prueba real) ─────────────────';

DECLARE
  cv_id text; ms_id text; fu_id text; ok boolean;
BEGIN
  SELECT id INTO cv_id FROM conversations LIMIT 1;
  SELECT id INTO ms_id FROM messages      LIMIT 1;
  SELECT id INTO fu_id FROM follow_ups    LIMIT 1;

  IF cv_id IS NULL THEN
    RAISE NOTICE 'AVISO  · no hay conversaciones; no se puede probar la inmutabilidad';
  ELSE
    -- owner inmutable
    ok := false;
    BEGIN
      UPDATE conversations SET "ownerType" =
        CASE WHEN "ownerType"='CLUB' THEN 'PROMOTER' ELSE 'CLUB' END::"ChannelOwnerType"
       WHERE id = cv_id;
    EXCEPTION WHEN others THEN ok := true;
    END;
    IF ok THEN RAISE NOTICE 'OK     · owner inmutable (rechazado en caliente)';
    ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · se pudo cambiar el owner de una conversación'; END IF;

    -- channelId inmutable
    ok := false;
    BEGIN
      UPDATE conversations SET "channelId" = "channelId" || '_x' WHERE id = cv_id;
    EXCEPTION WHEN others THEN ok := true;
    END;
    IF ok THEN RAISE NOTICE 'OK     · Conversation.channelId inmutable';
    ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · se pudo cambiar el channelId'; END IF;

    -- contextClubId SÍ mutable
    ok := true;
    BEGIN
      UPDATE conversations SET "contextClubId" = NULL WHERE id = cv_id;
    EXCEPTION WHEN others THEN ok := false;
    END;
    IF ok THEN RAISE NOTICE 'OK     · contextClubId es mutable';
    ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · contextClubId no se deja cambiar'; END IF;
  END IF;

  IF ms_id IS NOT NULL THEN
    ok := false;
    BEGIN
      UPDATE messages SET "conversationId" = "conversationId" || '_x' WHERE id = ms_id;
    EXCEPTION WHEN others THEN ok := true;
    END;
    IF ok THEN RAISE NOTICE 'OK     · Message.conversationId inmutable';
    ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · se pudo cambiar Message.conversationId'; END IF;
  END IF;

  IF fu_id IS NOT NULL THEN
    ok := false;
    BEGIN
      UPDATE follow_ups SET "conversationId" = "conversationId" || '_x' WHERE id = fu_id;
    EXCEPTION WHEN others THEN ok := true;
    END;
    IF ok THEN RAISE NOTICE 'OK     · FollowUp.conversationId inmutable';
    ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · se pudo cambiar FollowUp.conversationId'; END IF;
  ELSE
    RAISE NOTICE 'AVISO  · no hay follow_ups; no se pudo probar su inmutabilidad';
  END IF;

  -- Deshacer todo lo que haya podido colar (contextClubId sí cambió).
  RAISE EXCEPTION USING ERRCODE='22000', MESSAGE='__rollback_pruebas__';
EXCEPTION WHEN others THEN
  IF SQLERRM <> '__rollback_pruebas__' THEN RAISE; END IF;
END;

-- ════ F. RLS ════════════════════════════════════════════════════════
RAISE NOTICE '── F. RLS ─────────────────────────────────────────';

SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
 WHERE ns.nspname='public' AND c.relrowsecurity AND c.relname = ANY(tablas_owner);
IF n = 6 THEN RAISE NOTICE 'OK     · RLS activo en las 6 tablas';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · RLS activo en % de 6 tablas', n; END IF;

-- FORCE: sin esto, si la aplicación se conectara con el dueño de las tablas
-- se saltaría sus propias políticas.
SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
 WHERE ns.nspname='public' AND c.relforcerowsecurity AND c.relname = ANY(tablas_owner);
IF n = 6 THEN RAISE NOTICE 'OK     · FORCE ROW LEVEL SECURITY en las 6';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · FORCE solo en % de 6 tablas', n; END IF;

SELECT count(*) INTO n FROM pg_policies
 WHERE schemaname='public' AND policyname='tenant_isolation' AND tablename = ANY(tablas_owner);
IF n = 6 THEN RAISE NOTICE 'OK     · las 6 políticas tenant_isolation existen';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · hay % políticas, esperaba 6', n; END IF;

-- Ninguna de las seis puede quedarse con RLS y sin política: sería negar el
-- acceso a todo el mundo devolviendo cero filas sin decir por qué.
FOREACH t IN ARRAY tablas_owner LOOP
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=t;
  IF n = 0 THEN fallos := fallos+1;
    RAISE NOTICE 'FALLA  · % tiene RLS activo y NINGUNA política', t; END IF;
END LOOP;

SELECT string_agg(tablename, ', ') INTO txt FROM pg_policies
 WHERE schemaname='public' AND policyname='tenant_isolation'
   AND tablename = ANY(tablas_owner) AND with_check IS NULL;
IF txt IS NULL THEN RAISE NOTICE 'OK     · todas las políticas tienen WITH CHECK';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · sin WITH CHECK: % (escritura sin control)', txt; END IF;

-- Dirigidas a nl_app y no a PUBLIC.
SELECT string_agg(tablename, ', ') INTO txt FROM pg_policies
 WHERE schemaname='public' AND policyname='tenant_isolation'
   AND tablename = ANY(tablas_owner) AND NOT (roles::text[] @> ARRAY['nl_app']);
IF txt IS NULL THEN RAISE NOTICE 'OK     · las 6 políticas van dirigidas a nl_app';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · políticas no dirigidas a nl_app: %', txt; END IF;

-- `contextClubId` no puede aparecer en ninguna política. Si apareciera, un
-- club leería los mensajes privados de un RRPP solo porque en algún momento
-- se habló de ese club.
SELECT count(*) INTO n FROM pg_policies
 WHERE schemaname='public'
   AND (coalesce(qual,'') LIKE '%contextClubId%' OR coalesce(with_check,'') LIKE '%contextClubId%');
IF n = 0 THEN RAISE NOTICE 'OK     · contextClubId no participa en ninguna política';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · contextClubId aparece en % políticas — FUGA', n; END IF;

-- Las dos variables, con missing_ok. Con `false`, no tenerlas fijadas
-- lanzaría excepción en vez de devolver cero filas: fallar cerrado es
-- devolver nada, no reventar.
SELECT count(*) INTO n FROM pg_policies
 WHERE schemaname='public' AND policyname='tenant_isolation' AND tablename = ANY(tablas_owner)
   AND qual LIKE '%current_setting(''app.current_club_id''::text, true)%'
   AND qual LIKE '%current_setting(''app.current_promoter_id''::text, true)%';
IF n = 6 THEN RAISE NOTICE 'OK     · las 6 leen ambas variables con missing_ok';
ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · solo % políticas leen ambas variables con missing_ok', n; END IF;

-- ════ G. El rol de la aplicación ════════════════════════════════════
RAISE NOTICE '── G. Rol nl_app ──────────────────────────────────';

SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
  INTO r FROM pg_roles WHERE rolname = 'nl_app';
IF NOT FOUND THEN
  fallos := fallos+1; RAISE NOTICE 'FALLA  · no existe el rol nl_app (falta app-role.sql)';
ELSE
  RAISE NOTICE 'OK     · nl_app existe';
  IF r.rolcanlogin THEN RAISE NOTICE 'OK     · LOGIN';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app no puede conectarse'; END IF;
  IF NOT r.rolsuper THEN RAISE NOTICE 'OK     · rolsuper = false';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app es SUPERUSUARIO: RLS no se le aplica'; END IF;
  IF NOT r.rolbypassrls THEN RAISE NOTICE 'OK     · rolbypassrls = false';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app tiene BYPASSRLS: las políticas son decorativas'; END IF;
  IF NOT r.rolcreatedb   THEN RAISE NOTICE 'OK     · NOCREATEDB';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app puede crear bases de datos'; END IF;
  IF NOT r.rolcreaterole THEN RAISE NOTICE 'OK     · NOCREATEROLE';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app puede crear roles'; END IF;
  IF NOT r.rolreplication THEN RAISE NOTICE 'OK     · NOREPLICATION';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app puede replicar'; END IF;

  -- Privilegios REALES, no los que uno cree haber concedido.
  SELECT count(*) INTO n FROM unnest(tablas_owner) AS x(t)
   WHERE has_table_privilege('nl_app', 'public.'||quote_ident(x.t), 'SELECT');
  IF n = 6 THEN RAISE NOTICE 'OK     · nl_app tiene SELECT en las 6 tablas';
  ELSE fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app tiene SELECT en % de 6', n; END IF;

  -- Y NO puede saltarse el esquema por arriba.
  IF has_table_privilege('nl_app', 'pg_authid', 'SELECT') THEN
    fallos := fallos+1; RAISE NOTICE 'FALLA  · nl_app puede leer pg_authid';
  ELSE RAISE NOTICE 'OK     · nl_app no puede leer pg_authid';
  END IF;
END IF;

-- anon / authenticated (PostgREST) no deben tocar las 6 tablas internas.
FOREACH t IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
    SELECT string_agg(x.tbl, ', ') INTO txt FROM (
      SELECT u AS tbl FROM unnest(tablas_owner) AS u
       WHERE has_table_privilege(t, 'public.'||quote_ident(u), 'SELECT,INSERT,UPDATE,DELETE')
    ) x;
    IF txt IS NULL THEN RAISE NOTICE 'OK     · % no tiene CRUD sobre las tablas internas', t;
    ELSE fallos := fallos+1;
      RAISE NOTICE 'FALLA  · % tiene CRUD sobre: % (expuestas por PostgREST)', t, txt; END IF;
  ELSE
    RAISE NOTICE 'AVISO  · el rol % no existe aquí (normal fuera de Supabase)', t;
  END IF;
END LOOP;

-- Informativo: qué roles con login se saltan RLS. No se afirma cuáles son
-- en tu instalación — se leen. Ninguno de estos puede estar en DATABASE_URL.
SELECT string_agg(rolname, ', ') INTO txt FROM pg_roles
 WHERE (rolsuper OR rolbypassrls) AND rolcanlogin AND rolname NOT LIKE 'pg@_%' ESCAPE '@';
RAISE NOTICE 'AVISO  · roles con login que se saltan RLS: %', coalesce(txt, '(ninguno)');
RAISE NOTICE '         DATABASE_URL no puede usar ninguno de esos.';

-- ════ Recuento ══════════════════════════════════════════════════════
RAISE NOTICE '───────────────────────────────────────────────────';
IF fallos = 0 THEN
  RAISE NOTICE 'Todo correcto. 0 fallos.';
ELSE
  RAISE EXCEPTION '% comprobaciones fallidas. No sigas.', fallos;
END IF;
END $$;
