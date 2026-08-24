-- ════════════════════════════════════════════════════════════════════
-- RLS con propietario polimórfico
--
-- Sustituye a la política única de `rls.sql` en las seis tablas que ya no
-- pertenecen siempre a un club.
--
-- Orden de ejecución:
--   1. 001-channel-owner.sql
--   2. app-role.sql          ← crea nl_app; las políticas van dirigidas a él
--   3. este archivo
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/rls-owner.sql
--
-- Por qué no vale la política vieja: era
--   USING ("clubId" = current_setting('app.current_club_id', true))
-- y con `ownerClubId` nullable esto **rompe en silencio**. En SQL,
-- `NULL = 'algo'` no es falso: es NULL, que tampoco es verdadero. Una
-- conversación de promoter sería invisible para todo el mundo, incluido su
-- dueño, y no daría ningún error. Solo cero filas.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ── 0. nl_app tiene que existir y ser inofensivo ────────────────────
-- Las políticas llevan `TO nl_app`. Si el rol no existe, CREATE POLICY
-- falla; mejor fallar aquí con un mensaje que se entienda.
--
-- Y se comprueban sus atributos REALES, no lo que uno supone que son: a un
-- rol con BYPASSRLS las políticas no se le aplican, y todo este archivo
-- sería decoración. No damos por hecho qué es cada rol en tu instalación —
-- lo leemos de pg_roles.
DO $$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin INTO r
    FROM pg_roles WHERE rolname = 'nl_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el rol nl_app. Ejecuta antes app-role.sql.';
  END IF;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'nl_app es superusuario (%) o tiene BYPASSRLS (%). Las políticas no se le aplicarían.',
      r.rolsuper, r.rolbypassrls;
  END IF;
  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'nl_app no puede iniciar sesión; la aplicación no podría conectarse.';
  END IF;
END $$;

-- ── Grupo 1: siguen siendo solo de club ─────────────────────────────
-- events, ticket_types, vip_options, faqs, brand_settings, ai_configs...
-- Su política no cambia; se sigue aplicando desde rls.sql.

-- ── Grupo 2: dueño polimórfico ──────────────────────────────────────
--
-- `TO nl_app` y no PUBLIC: una política dirigida a PUBLIC alcanza a todo rol
-- presente y futuro, incluidos los que Supabase cree por su cuenta. Dirigida
-- a nl_app, cualquier otro rol sin BYPASSRLS ve **cero filas** — que es el
-- comportamiento correcto para un rol que no debería estar tocando estas
-- tablas.
--
-- Consecuencia que hay que tener presente: con FORCE activo, el propio dueño
-- de las tablas tampoco tiene política, así que también ve cero filas. Por
-- eso `verification.sql` y `001-channel-owner.sql` empiezan comprobando que
-- su sesión NO está filtrada; si lo estuviera, informarían «0 problemas»
-- sobre una vista vacía.
DO $$
DECLARE
  t          text;
  club_col   text;
  prom_col   text;
  owner_tables text[] := ARRAY[
    'channels', 'conversations', 'messages', 'customers',
    'follow_ups', 'ai_request_logs'
  ];
BEGIN
  FOREACH t IN ARRAY owner_tables LOOP
    -- `channels` guarda el dueño en clubId/promoterId; el resto en
    -- ownerClubId/ownerPromoterId. Es la única diferencia entre ellas.
    club_col := CASE WHEN t = 'channels' THEN 'clubId'     ELSE 'ownerClubId'     END;
    prom_col := CASE WHEN t = 'channels' THEN 'promoterId' ELSE 'ownerPromoterId' END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);

    -- El `IS NOT NULL` de cada rama no es redundante: sin él, una fila de
    -- promoter comparada contra app.current_club_id daría NULL (ni cierto ni
    -- falso) y quedaría invisible hasta para su dueño, sin error alguno.
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        TO nl_app
        USING (
          (%I IS NOT NULL
             AND %I = current_setting('app.current_club_id', true))
          OR
          (%I IS NOT NULL
             AND %I = current_setting('app.current_promoter_id', true))
        )
        WITH CHECK (
          (%I IS NOT NULL
             AND %I = current_setting('app.current_club_id', true))
          OR
          (%I IS NOT NULL
             AND %I = current_setting('app.current_promoter_id', true))
        )
    $f$,
      t,
      club_col, club_col, prom_col, prom_col,
      club_col, club_col, prom_col, prom_col
    );
  END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- `contextClubId` NO aparece en ninguna política, y es deliberado.
--
-- Es «de qué se habla», no «de quién es». Si entrara, un club podría leer
-- los mensajes privados que un cliente le manda a un RRPP solo porque en
-- algún momento se mencionó el nombre del club. Sería una fuga de datos
-- entre negocios disfrazada de funcionalidad.
--
-- La aplicación fija SIEMPRE LAS DOS variables en cada transacción, una con
-- valor y la otra vacía:
--
--   -- panel de club
--   set_config('app.current_club_id',     '<clubId>', true);
--   set_config('app.current_promoter_id', '',         true);
--
--   -- panel de RRPP
--   set_config('app.current_club_id',     '',            true);
--   set_config('app.current_promoter_id', '<promoterId>', true);
--
-- Fijar las dos siempre, y no solo la que toca, es lo que hace que una
-- variable contaminada a nivel de SESIÓN en una conexión reutilizada no
-- pueda dar acceso: la vacía la pisa. Un `ownerClubId` nunca es la cadena
-- vacía, así que `'' = ''` no puede colar ninguna fila — el `IS NOT NULL`
-- solo descarta los nulos, y la comparación hace el resto.
--
-- El tercer argumento es SIEMPRE `true` (local a la transacción): con
-- `false` la variable sobrevive al COMMIT y se queda pegada a la conexión
-- del pooler, que es exactamente la fuga que esto evita.
--
-- Ver `docs/forOwner.md` para la implementación en TypeScript.
-- ════════════════════════════════════════════════════════════════════
