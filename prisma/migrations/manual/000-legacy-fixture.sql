-- Réplica del esquema ACTUAL (antes de la migración) con datos de prueba.
-- Solo sirve para ensayar la migración; no forma parte del despliegue.

CREATE TYPE "ChannelType"        AS ENUM ('WEBCHAT','WHATSAPP','INSTAGRAM');
CREATE TYPE "ChannelStatus"      AS ENUM ('DISCONNECTED','CONNECTED','ERROR');
CREATE TYPE "ConversationStatus" AS ENUM ('AI_ACTIVE','WAITING_HUMAN','HUMAN_ACTIVE','POTENTIAL_PURCHASE','CLOSED');
CREATE TYPE "MessageRole"        AS ENUM ('CUSTOMER','ASSISTANT','HUMAN_AGENT','SYSTEM');
CREATE TYPE "FollowUpStatus"     AS ENUM ('SUGGESTED','SENT','DISMISSED');

CREATE TABLE clubs (
  id text PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL
);
CREATE TABLE promoters (
  id text PRIMARY KEY, slug text UNIQUE NOT NULL, "displayName" text NOT NULL
);
CREATE TABLE channels (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  type "ChannelType" NOT NULL,
  status "ChannelStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "externalAccountId" text,
  "credentialsEncrypted" text,
  "webhookSecret" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("clubId", type)
);
CREATE TABLE customers (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "channelType" "ChannelType" NOT NULL,
  "externalHandleHash" text NOT NULL,
  "displayName" text,
  locale text NOT NULL DEFAULT 'es',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("clubId","channelType","externalHandleHash")
);
CREATE TABLE conversations (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "promoterId" text REFERENCES promoters(id) ON DELETE SET NULL,
  "customerId" text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  "channelId" text REFERENCES channels(id) ON DELETE SET NULL,
  "channelType" "ChannelType" NOT NULL DEFAULT 'WEBCHAT',
  status "ConversationStatus" NOT NULL DEFAULT 'AI_ACTIVE',
  "lastMessageAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE TABLE messages (
  id text PRIMARY KEY,
  "conversationId" text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  role "MessageRole" NOT NULL,
  content text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE follow_ups (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "conversationId" text UNIQUE NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "promoterId" text,
  "suggestedMessage" text NOT NULL,
  status "FollowUpStatus" NOT NULL DEFAULT 'SUGGESTED'
);
CREATE TABLE ai_request_logs (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "promoterId" text,
  "conversationId" text,
  "resolvedBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- ── datos legacy ────────────────────────────────────────────────────
INSERT INTO clubs VALUES ('club_mon','mon-madrid','MON Madrid'), ('club_lib','liberata','Liberata');
INSERT INTO promoters VALUES ('prom_javi','javier-de-leon','Javier De Leon');

-- Un canal webchat para MON; Liberata NO tiene canal (el caso feo).
INSERT INTO channels (id,"clubId",type,status) VALUES ('ch_mon_web','club_mon','WEBCHAT','CONNECTED');

INSERT INTO customers (id,"clubId","channelType","externalHandleHash") VALUES
  ('cus_1','club_mon','WEBCHAT','hash-aaa'),
  ('cus_2','club_mon','WEBCHAT','hash-bbb'),
  ('cus_3','club_lib','WEBCHAT','hash-ccc');   -- cliente de un club SIN canal

INSERT INTO conversations (id,"clubId","promoterId","customerId","channelId") VALUES
  ('cv_1','club_mon',NULL,'cus_1','ch_mon_web'),
  ('cv_2','club_mon','prom_javi','cus_2','ch_mon_web'),  -- llegó por un promoter
  ('cv_3','club_lib',NULL,'cus_3',NULL);                 -- sin canal

INSERT INTO messages (id,"conversationId","clubId",role,content) VALUES
  ('ms_1','cv_1','club_mon','CUSTOMER','hola'),
  ('ms_2','cv_1','club_mon','ASSISTANT','buenas'),
  ('ms_3','cv_2','club_mon','CUSTOMER','precio?'),
  ('ms_4','cv_3','club_lib','CUSTOMER','abrís hoy?');

INSERT INTO follow_ups (id,"clubId","conversationId","suggestedMessage") VALUES
  ('fu_1','club_mon','cv_2','¿Te reservo?');
INSERT INTO ai_request_logs (id,"clubId","conversationId","resolvedBy") VALUES
  ('ai_1','club_mon','cv_1','LLM');

-- ── Tablas de pertenencia ───────────────────────────────────────────
-- Réplica reducida. Están aquí porque la migración 011 cambia su régimen de
-- RLS y sin ellas no se puede probar el fallo que arregla: que con la
-- política circular de rls.sql nadie pueda iniciar sesión.
CREATE TABLE club_members (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  role text NOT NULL DEFAULT 'STAFF'
);
CREATE TABLE promoter_clubs (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "promoterId" text NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'APPROVED'
);
CREATE TABLE promoter_events (
  id text PRIMARY KEY,
  "clubId" text NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  "promoterId" text NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  "eventId" text NOT NULL
);
INSERT INTO club_members VALUES ('cm_javi_mon','club_mon','user_javi','OWNER');
INSERT INTO promoter_clubs VALUES
  ('pc_javi_mon','club_mon','prom_javi','APPROVED'),
  ('pc_javi_lib','club_lib','prom_javi','APPROVED');
INSERT INTO promoter_events VALUES ('pe_javi_1','club_mon','prom_javi','ev_futuro');

-- ── RLS legacy (lo que hace prisma/rls.sql sobre estas seis) ────────
-- Está aquí para que el ensayo parta del estado REAL de producción, no de
-- una base sin políticas. Sin esto, el paso 6 del rollback («restaurar las
-- políticas antiguas») no se podría comprobar contra nada.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','conversations','messages','customers',
                           'follow_ups','ai_request_logs',
                           'club_members','promoter_clubs','promoter_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("clubId" = current_setting('app.current_club_id', true))
        WITH CHECK ("clubId" = current_setting('app.current_club_id', true))
    $f$, t);
  END LOOP;
END $$;
