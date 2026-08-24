-- ════════════════════════════════════════════════════════════════════
-- Deshacer 010-beta-tables.sql
--
-- Se ejecuta ANTES del rollback de 001: los triggers de 010 usan las
-- funciones que crea 001, así que desmontar 001 primero falla con
-- «cannot drop function ... because other objects depend on it». Las
-- migraciones se deshacen en orden inverso, como se aplicaron.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--        -f prisma/migrations/manual/010-beta-tables-rollback.sql
--
-- ESTO SÍ BORRA DATOS: las preguntas sin respuesta, el feedback de los
-- testers y el conocimiento propio de los RRPPs viven solo en estas cuatro
-- tablas. No hay dónde guardarlos en el modelo anterior porque antes no
-- existían. Por eso aborta si hay algo dentro, y hay que decidir a mano qué
-- se hace con ello.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

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
    RAISE EXCEPTION 'El rol % está sujeto a RLS: el recuento de abajo no vería los datos. Usa DIRECT_URL.', current_user;
  END IF;
END $$;

-- ── Cortafuegos ─────────────────────────────────────────────────────
DO $$
DECLARE t text; n bigint; total bigint := 0; det text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['unanswered_questions','beta_feedback',
                           'promoter_knowledge','promoter_faqs'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        total := total + n;
        det := CASE WHEN det = '' THEN format('%s: %s', t, n)
                    ELSE det || format(', %s: %s', t, n) END;
      END IF;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION
      'Hay % filas en las tablas de la beta (%). El modelo anterior no puede guardarlas: deshacer las borraría. Expórtalas o vacíalas primero.',
      total, det;
  END IF;
END $$;

-- ── Triggers propios ────────────────────────────────────────────────
-- Solo los de 010. Las FUNCIONES son de 001 y las usan otras tablas: no se
-- tocan aquí.
DROP TRIGGER IF EXISTS nl_unanswered_conversation_t ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_unanswered_immutable_t    ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_unanswered_owner_t        ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_feedback_immutable_t      ON beta_feedback;

-- ── Tablas ──────────────────────────────────────────────────────────
-- Al caer la tabla caen sus políticas, sus índices y sus CHECK.
DROP TABLE IF EXISTS unanswered_questions;
DROP TABLE IF EXISTS beta_feedback;
DROP TABLE IF EXISTS promoter_knowledge;
DROP TABLE IF EXISTS promoter_faqs;

DROP TYPE IF EXISTS "UnansweredStatus";
DROP TYPE IF EXISTS "FeedbackKind";

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('unanswered_questions','beta_feedback',
                        'promoter_knowledge','promoter_faqs');
  IF n <> 0 THEN RAISE EXCEPTION 'Quedan % tablas de 010 sin borrar', n; END IF;

  -- Las funciones de 001 tienen que seguir ahí: son de la otra migración.
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'nl_child_owner_from_conversation';
  IF n <> 1 THEN RAISE EXCEPTION 'Se ha borrado una función que pertenece a 001'; END IF;

  RAISE NOTICE '010 deshecha: 4 tablas y 2 tipos eliminados. Las funciones de 001 siguen intactas.';
END $$;

COMMIT;
