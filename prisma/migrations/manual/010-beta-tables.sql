-- ════════════════════════════════════════════════════════════════════
-- 010 · Tablas nuevas de la beta
--
-- ESTO NO ES LA LIMPIEZA DE COLUMNAS LEGACY. Esa sigue pendiente, es otra
-- migración y no tiene número asignado todavía. Este archivo solo CREA
-- tablas: no altera ninguna existente, no borra ninguna columna y no toca
-- un solo dato.
--
-- Se ejecuta DESPUÉS de 001-channel-owner.sql, app-role.sql y
-- rls-owner.sql, porque reutiliza el tipo ChannelOwnerType, el rol nl_app y
-- el mismo patrón de políticas.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--        -f prisma/migrations/manual/010-beta-tables.sql
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Mismo control que en 001: si esta sesión está sujeta a RLS, los triggers
-- que creamos abajo mirarían una vista vacía y las tablas quedarían mal.
DO $$
DECLARE filtrado boolean := false;
BEGIN
  BEGIN
    PERFORM set_config('row_security', 'off', true);
    PERFORM count(*) FROM conversations;
  EXCEPTION WHEN others THEN filtrado := true;
  END;
  PERFORM set_config('row_security', 'on', true);
  IF filtrado THEN
    RAISE EXCEPTION 'El rol % está sujeto a RLS. Usa DIRECT_URL.', current_user;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UnansweredStatus') THEN
    CREATE TYPE "UnansweredStatus" AS ENUM ('OPEN', 'ANSWERED', 'DISMISSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FeedbackKind') THEN
    CREATE TYPE "FeedbackKind" AS ENUM ('ERROR', 'SUGGESTION', 'INTEGRATION', 'OTHER');
  END IF;
END $$;

-- ── Preguntas sin respuesta ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unanswered_questions (
  id                 text PRIMARY KEY,
  "ownerType"        "ChannelOwnerType" NOT NULL,
  "ownerClubId"      text REFERENCES clubs(id)     ON DELETE CASCADE,
  "ownerPromoterId"  text REFERENCES promoters(id) ON DELETE CASCADE,
  "conversationId"   text REFERENCES conversations(id) ON DELETE SET NULL,
  "channelType"      "ChannelType",
  "originalQuestion" text NOT NULL,
  "detectedIntent"   text,
  reason             text,
  status             "UnansweredStatus" NOT NULL DEFAULT 'OPEN',
  answer             text,
  "answeredBy"       text,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "resolvedAt"       timestamptz,
  CONSTRAINT unanswered_questions_one_owner CHECK (
    ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
    ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS unanswered_owner_club_status_idx
  ON unanswered_questions ("ownerClubId", status);
CREATE INDEX IF NOT EXISTS unanswered_owner_promoter_status_idx
  ON unanswered_questions ("ownerPromoterId", status);

-- ── Feedback de la beta ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beta_feedback (
  id                text PRIMARY KEY,
  "ownerType"       "ChannelOwnerType" NOT NULL,
  "ownerClubId"     text REFERENCES clubs(id)     ON DELETE CASCADE,
  "ownerPromoterId" text REFERENCES promoters(id) ON DELETE CASCADE,
  "userId"          text,
  kind              "FeedbackKind" NOT NULL,
  message           text NOT NULL,
  path              text,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beta_feedback_one_owner CHECK (
    ("ownerType" = 'CLUB'     AND "ownerClubId" IS NOT NULL AND "ownerPromoterId" IS NULL) OR
    ("ownerType" = 'PROMOTER' AND "ownerPromoterId" IS NOT NULL AND "ownerClubId" IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS beta_feedback_created_idx ON beta_feedback ("createdAt");

-- ── Conocimiento propio del RRPP ────────────────────────────────────
-- Tablas separadas de faqs/knowledge_items en vez de añadirles columnas de
-- dueño: así 010 no altera ninguna tabla existente. Que el RRPP no pueda
-- sobrescribir las reglas del club no lo garantiza el esquema, lo garantiza
-- el orden de autoridad en @nightlife/ai/knowledge.
CREATE TABLE IF NOT EXISTS promoter_knowledge (
  id           text PRIMARY KEY,
  "promoterId" text NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  "isActive"   boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS promoter_knowledge_active_idx
  ON promoter_knowledge ("promoterId", "isActive");

CREATE TABLE IF NOT EXISTS promoter_faqs (
  id           text PRIMARY KEY,
  "promoterId" text NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  question     text NOT NULL,
  answer       text NOT NULL,
  keywords     text[] NOT NULL DEFAULT '{}',
  intent       text,
  "isActive"   boolean NOT NULL DEFAULT true,
  "sortOrder"  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS promoter_faqs_active_idx
  ON promoter_faqs ("promoterId", "isActive");

-- ── Derivación e inmutabilidad del dueño ────────────────────────────
-- Misma regla que en 001: vacío → derivar, igual → aceptar, distinto →
-- rechazar. Se reutilizan las funciones existentes; no se define ninguna
-- nueva, para que la lista exacta de verification.sql siga valiendo.
DROP TRIGGER IF EXISTS nl_unanswered_conversation_t ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_unanswered_immutable_t    ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_unanswered_owner_t        ON unanswered_questions;
DROP TRIGGER IF EXISTS nl_feedback_immutable_t      ON beta_feedback;

CREATE TRIGGER nl_unanswered_conversation_t
  BEFORE UPDATE ON unanswered_questions FOR EACH ROW
  EXECUTE FUNCTION nl_conversation_ref_immutable();
CREATE TRIGGER nl_unanswered_immutable_t
  BEFORE UPDATE ON unanswered_questions FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();
CREATE TRIGGER nl_unanswered_owner_t
  BEFORE INSERT OR UPDATE OF "conversationId", "ownerType", "ownerClubId", "ownerPromoterId"
  ON unanswered_questions FOR EACH ROW
  EXECUTE FUNCTION nl_child_owner_from_conversation();

-- El feedback no cuelga de ninguna conversación: su dueño viene del
-- contexto de servidor. Solo se congela para que no se pueda reasignar.
CREATE TRIGGER nl_feedback_immutable_t
  BEFORE UPDATE ON beta_feedback FOR EACH ROW
  EXECUTE FUNCTION nl_owner_immutable();

-- ── RLS ─────────────────────────────────────────────────────────────
-- Las dos tablas con dueño llevan el mismo patrón que las seis de 001.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unanswered_questions', 'beta_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        TO nl_app
        USING (
          ("ownerClubId" IS NOT NULL
             AND "ownerClubId" = current_setting('app.current_club_id', true))
          OR
          ("ownerPromoterId" IS NOT NULL
             AND "ownerPromoterId" = current_setting('app.current_promoter_id', true))
        )
        WITH CHECK (
          ("ownerClubId" IS NOT NULL
             AND "ownerClubId" = current_setting('app.current_club_id', true))
          OR
          ("ownerPromoterId" IS NOT NULL
             AND "ownerPromoterId" = current_setting('app.current_promoter_id', true))
        )
    $f$, t);
    EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO nl_app', t);
  END LOOP;
END $$;

-- Las dos del RRPP van por promoterId, que ya ES el dueño: no hace falta
-- denormalizar nada.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promoter_knowledge', 'promoter_faqs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        TO nl_app
        USING ("promoterId" = current_setting('app.current_promoter_id', true))
        WITH CHECK ("promoterId" = current_setting('app.current_promoter_id', true))
    $f$, t);
    EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO nl_app', t);
  END LOOP;
END $$;

-- anon / authenticated: fuera, igual que las seis internas.
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['unanswered_questions','beta_feedback',
                               'promoter_knowledge','promoter_faqs'] LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('unanswered_questions','beta_feedback',
                        'promoter_knowledge','promoter_faqs');
  IF n <> 4 THEN RAISE EXCEPTION 'Solo se crearon % de 4 tablas', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND policyname='tenant_isolation'
     AND tablename IN ('unanswered_questions','beta_feedback',
                       'promoter_knowledge','promoter_faqs');
  IF n <> 4 THEN RAISE EXCEPTION 'Solo hay % de 4 políticas', n; END IF;

  RAISE NOTICE '010: 4 tablas nuevas, 4 políticas, 4 triggers. Nada existente modificado.';
END $$;

COMMIT;
