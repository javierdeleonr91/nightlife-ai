#!/usr/bin/env bash
# Ensayo completo contra una base PostgreSQL LOCAL de pruebas.
# Este script crea y elimina la base indicada por DB; no usar contra producción.
# Ver docs/migracion-canales.md.
set -euo pipefail

# En Linux puede existir esta instalación concreta de PostgreSQL.
# En macOS o cualquier otro entorno se utiliza el psql disponible en PATH.
if [ -d /usr/lib/postgresql/16/bin ]; then
  export PATH="/usr/lib/postgresql/16/bin:$PATH"
fi

export PGHOST=${PGHOST:-/tmp}
export PGPORT=${PGPORT:-55432}
export PGUSER=${PGUSER:-nl}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
R=${R:-"$(cd "$SCRIPT_DIR/.." && pwd)"}
M=$R/prisma/migrations/manual
T=$M/tests
DB=${DB:-migtest}
PW="pipeline-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"

paso () { echo; echo "════ $* ════"; }
run  () { psql -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }
app  () { PGPASSWORD="$PW" psql -U nl_app -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
clean() { sed 's/^psql:[^ ]* //'; }

paso "0 · base limpia"
psql -d postgres -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

paso "1 · fixture legacy"
run -f "$M/000-legacy-fixture.sql"

paso "2 · 001-channel-owner.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/001-channel-owner.sql" 2>&1 | grep -E 'NOTICE|ERROR' | clean || true

paso "3 · app-role.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -v nl_app_password="$PW" -f "$M/app-role.sql" 2>&1 | clean

paso "4 · rls-owner.sql"
run -f "$R/prisma/rls-owner.sql"
echo "políticas tenant_isolation: $(psql -d "$DB" -tAq -c "SELECT count(*) FROM pg_policies WHERE policyname='tenant_isolation'")"

paso "5 · 010 + 011 (tablas de beta y pertenencia)"
run -f "$M/010-beta-tables.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/011-rls-membership.sql" 2>&1 | grep -E 'NOTICE|ERROR' | clean

paso "6 · seed de promoter"
run -f "$T/seed-promoter.sql"

paso "7 · trigger-tests.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$T/trigger-tests.sql" 2>&1 | grep -E 'OK |FALLA|VERDE|ERROR|── ' | clean

paso "8 · rls-pooling-tests.sql  (como nl_app)"
app -f "$T/rls-pooling-tests.sql" 2>&1 | grep -E 'OK |FALLA|AVISO|VERDE|ERROR|Rol de' | clean

paso "9 · membership + webchat (como nl_app)"
app -f "$T/membership-tests.sql" 2>&1 | grep -E 'OK |FALLA|VERDE|ERROR' | clean
app -f "$T/webchat-flow-tests.sql" 2>&1 | grep -E 'OK |FALLA|VERDE|ERROR' | clean

paso "9 bis · flujo público (como nl_app)"
app -f "$T/public-flow-tests.sql" 2>&1 | grep -E 'OK |FALLA|VERDE|ERROR' | clean

paso "10 · verification.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/verification.sql" 2>&1 | grep -E 'OK |FALLA|AVISO|correcto|ERROR|── ' | clean

paso "11 · deshacer 010 (las migraciones se desmontan en orden inverso)"
run -c "DELETE FROM unanswered_questions" -c "DELETE FROM beta_feedback" \
    -c "DELETE FROM promoter_knowledge" -c "DELETE FROM promoter_faqs"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/010-beta-tables-rollback.sql" 2>&1 | grep -E 'NOTICE|ERROR' | clean
paso "12 · rollback de 001 — debe ABORTAR (hay datos de promoter)"
# Sin tubería a `grep -q`: con `pipefail`, grep sale antes de tiempo, psql
# recibe SIGPIPE y la condición daría falso aunque el mensaje estuviera.
salida=$(psql -d "$DB" -f "$M/001-channel-owner-rollback.sql" 2>&1 || true)
if grep -q 'filas de promoter' <<<"$salida"; then
  echo "OK · el cortafuegos abortó el rollback como debía:"
  grep -o 'Hay .* Decide qué hacer con ellas antes.' <<<"$salida" | head -1
else
  echo "FALLA · el rollback NO abortó con datos de promoter"; echo "$salida" | tail -5; exit 1
fi
paso "13 · retirar datos de promoter y deshacer de verdad"
run -c "DELETE FROM messages WHERE \"ownerType\"='PROMOTER'" \
    -c "DELETE FROM ai_request_logs WHERE \"ownerType\"='PROMOTER'" \
    -c "DELETE FROM follow_ups WHERE \"ownerType\"='PROMOTER'" \
    -c "DELETE FROM conversations WHERE \"ownerType\"='PROMOTER'" \
    -c "DELETE FROM customers WHERE \"ownerType\"='PROMOTER'" \
    -c "DELETE FROM channels WHERE \"ownerType\"='PROMOTER'"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/001-channel-owner-rollback.sql" 2>&1 | grep -E 'NOTICE|ERROR' | clean
paso "14 · esquema legacy verificado"
psql -d "$DB" -tAq <<'X'
SELECT 'columnas nuevas restantes: ' || count(*) FROM information_schema.columns
 WHERE table_schema='public'
   AND column_name IN ('ownerType','ownerClubId','ownerPromoterId','contextClubId');
SELECT 'tipo ChannelOwnerType: ' || count(*) FROM pg_type WHERE typname='ChannelOwnerType';
SELECT 'triggers nl_ restantes: ' || count(*) FROM pg_trigger
 WHERE NOT tgisinternal AND tgname LIKE 'nl@_%' ESCAPE '@';
SELECT 'funciones nl_ restantes: ' || count(*) FROM pg_proc WHERE proname LIKE 'nl@_%' ESCAPE '@';
SELECT 'políticas legacy clubId: ' || count(*) FROM pg_policies
 WHERE schemaname='public' AND policyname='tenant_isolation'
   AND tablename IN ('channels','conversations','messages','customers','follow_ups','ai_request_logs')
   AND qual LIKE '%clubId%' AND qual NOT LIKE '%ownerClubId%';
SELECT 'filas cv/ms/cus/fu/ai: '
  || (SELECT count(*) FROM conversations)   || '/' || (SELECT count(*) FROM messages)
  || '/' || (SELECT count(*) FROM customers) || '/' || (SELECT count(*) FROM follow_ups)
  || '/' || (SELECT count(*) FROM ai_request_logs);
X

paso "15 · reaplicar todo desde cero"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/001-channel-owner.sql" 2>&1 | grep -E 'NOTICE:  Verific|ERROR' | clean
psql -d "$DB" -v ON_ERROR_STOP=1 -q -v nl_app_password="$PW" -f "$M/app-role.sql" >/dev/null 2>&1
run -f "$R/prisma/rls-owner.sql"
run -f "$M/010-beta-tables.sql"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$M/011-rls-membership.sql" >/dev/null 2>&1
run -f "$T/seed-promoter.sql"
echo "reaplicado"

paso "16 · verification.sql otra vez"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$M/verification.sql" 2>&1 | grep -E 'FALLA|correcto|ERROR' | clean

paso "17 · y las suites otra vez"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$T/trigger-tests.sql" 2>&1 | grep -E 'FALLA|VERDE|ERROR' | clean
app -f "$T/rls-pooling-tests.sql" 2>&1 | grep -E 'FALLA|VERDE|ERROR' | clean

echo; echo "════ PIPELINE COMPLETA ════"
