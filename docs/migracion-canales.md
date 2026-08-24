# Canales Meta para Club y RRPP — plan de migración

**Estado:** revisado y **ensayado contra un PostgreSQL real**. Nada ejecutado
sobre Supabase. `schema.prisma` sin tocar.

Todo el SQL de este documento se ha ejecutado sobre una réplica del esquema
actual con datos legacy — incluido el caso incómodo de un club con clientes
pero sin fila en `channels`. Los resultados están al final.

---

## 1. Diff Prisma final

### Tipo nuevo

```prisma
enum ChannelOwnerType {
  CLUB
  PROMOTER
}
```

### `Channel`

```prisma
model Channel {
  id                   String           @id @default(cuid())
  ownerType            ChannelOwnerType
  clubId               String?
  promoterId           String?
  type                 ChannelType
  status               ChannelStatus    @default(DISCONNECTED)

  /// El id que manda Meta en el webhook: IG user id o phone_number_id.
  /// Es lo ÚNICO que identifica al dueño de un mensaje entrante.
  externalAccountId    String?
  /// @javier_rrpp o +34 600 000 000. Solo para que la persona reconozca
  /// cuál conectó. Nunca se usa para resolver propiedad.
  displayName          String?

  /// AES-256-GCM (packages/core/secret-box.ts). Nunca sale al frontend.
  credentialsEncrypted String?
  tokenExpiresAt       DateTime?

  /// La IA responde sola aquí. Apagarlo NO desconecta el canal: los
  /// mensajes siguen llegando y esperan a una persona.
  autoReply            Boolean          @default(true)
  /// Solo WhatsApp: "COEXISTENCE" | "DEDICATED". Cambia lo que se le puede
  /// prometer al usuario sobre su app del móvil.
  waMode               String?
  lastErrorCode        String?

  createdAt            DateTime         @default(now())
  updatedAt            DateTime         @updatedAt

  club          Club?          @relation(fields: [clubId], references: [id], onDelete: Cascade)
  promoter      Promoter?      @relation(fields: [promoterId], references: [id], onDelete: Cascade)
  conversations Conversation[]
  customers     Customer[]

  @@unique([type, externalAccountId])
  @@unique([clubId, type])
  @@unique([promoterId, type])
  @@index([ownerType, status])
  @@map("channels")
}
```

`webhookSecret` desaparece: Meta firma con `X-Hub-Signature-256` usando el **app
secret**, uno por aplicación, en variables de entorno.

**Sobre `@@unique([type, externalAccountId])` y los NULL** — lo planteaste y está
comprobado: PostgreSQL trata cada NULL como distinto en un índice único
(`NULLS DISTINCT`, el comportamiento por defecto). Varios canales
`DISCONNECTED` con `externalAccountId` a NULL conviven sin chocar. Probado:
dos inserciones seguidas, las dos entran.

### `Conversation`

```prisma
model Conversation {
  id              String             @id @default(cuid())

  /// ── DE QUIÉN es. Clave de tenant. ──────────────────────────────
  ownerType       ChannelOwnerType
  ownerClubId     String?
  ownerPromoterId String?

  /// ── DE QUÉ se habla. NO es clave de tenant y NO da acceso. ──────
  contextClubId   String?

  /// LEGACY. Se elimina en la migración 002. Nada nuevo debe leerlo.
  clubId          String?
  /// LEGACY. Quién trajo al cliente; nunca fue el dueño.
  promoterId      String?

  customerId      String
  channelId       String
  channelType     ChannelType        @default(WEBCHAT)
  status          ConversationStatus @default(AI_ACTIVE)
  lastIntent      String?
  eventFocusId    String?
  partySize       Int?
  purchaseIntent  Boolean            @default(false)
  ctaClicked      Boolean            @default(false)
  /// Idioma detectado del cliente, para no re-adivinarlo en cada mensaje
  /// ni cambiar de idioma a mitad de conversación.
  locale          String?
  lastMessageAt   DateTime           @default(now())
  createdAt       DateTime           @default(now())
  expiresAt       DateTime

  ownerClub     Club?     @relation("ConversationOwnerClub",   fields: [ownerClubId],     references: [id], onDelete: Cascade)
  ownerPromoter Promoter? @relation("ConversationOwnerPromoter", fields: [ownerPromoterId], references: [id], onDelete: Cascade)
  contextClub   Club?     @relation("ConversationContextClub", fields: [contextClubId],   references: [id], onDelete: SetNull)
  customer      Customer  @relation(fields: [customerId], references: [id], onDelete: Cascade)
  channel       Channel   @relation(fields: [channelId], references: [id], onDelete: Cascade)
  messages      Message[]
  followUp      FollowUp?

  @@unique([id, ownerType])
  @@index([ownerClubId, status])
  @@index([ownerClubId, lastMessageAt])
  @@index([ownerPromoterId, status])
  @@index([ownerPromoterId, lastMessageAt])
  @@index([contextClubId])
  @@index([expiresAt])
  @@map("conversations")
}
```

`channelId` pasa a obligatorio: es lo que sostiene la cadena
`webhook → Channel → Owner → Customer → Conversation` sin fiarse de nada
externo. `contextClubId` con `SetNull`, no Cascade: si desaparece el club del
que se hablaba, la conversación del promoter no debe irse con él.

### `Customer`

```prisma
model Customer {
  id               String           @id @default(cuid())
  ownerType        ChannelOwnerType
  ownerClubId      String?
  ownerPromoterId  String?
  channelId        String

  /// HMAC con pepper del servidor. Es lo que se indexa y compara.
  externalUserHash String
  /// El IGSID o el teléfono REAL, cifrado con secret-box. Hace falta para
  /// poder responder: a un hash no se le contesta. Se descifra solo en el
  /// momento de enviar y nunca sale al frontend.
  externalUserRef  String?

  /// LEGACY, se eliminan en la 002.
  clubId             String?
  channelType        ChannelType?
  externalHandleHash String?

  displayName   String?
  locale        String    @default("es")
  consentAt     DateTime?
  consentSource String?
  createdAt     DateTime  @default(now())

  channel       Channel        @relation(fields: [channelId], references: [id], onDelete: Cascade)
  ownerClub     Club?          @relation(fields: [ownerClubId], references: [id], onDelete: Cascade)
  ownerPromoter Promoter?      @relation(fields: [ownerPromoterId], references: [id], onDelete: Cascade)
  conversations Conversation[]

  @@unique([channelId, externalUserHash])
  @@index([ownerClubId])
  @@index([ownerPromoterId])
  @@map("customers")
}
```

El mismo Instagram escribiendo a Javier y a MON son **dos clientes distintos**.
No se cruzan datos entre negocios.

### `Message`, `FollowUp`, `AiRequestLog`

Los tres llevan `ownerType` + `ownerClubId?` + `ownerPromoterId?`, mismo patrón,
y conservan su `clubId` como legacy. `Message` además:

```prisma
  @@index([ownerClubId])
  @@index([ownerPromoterId])
```

### `Club` y `Promoter`

Solo relaciones inversas, ningún campo nuevo.

```prisma
model Club {
  channels             Channel[]
  ownedConversations   Conversation[] @relation("ConversationOwnerClub")
  contextConversations Conversation[] @relation("ConversationContextClub")
  customers            Customer[]
}

model Promoter {
  channels      Channel[]
  conversations Conversation[] @relation("ConversationOwnerPromoter")
  customers     Customer[]
}
```

---

## 2. SQL de migración

`prisma/migrations/manual/001-channel-owner.sql`. Estructura:

```
BEGIN
 0. foto del estado inicial en tabla temporal
 1. CREATE TYPE ChannelOwnerType
 2. columnas nuevas, TODAS nullable
 2b. los NOT NULL legacy se relajan      ← lo encontró el ensayo
 3. claves foráneas (antes del relleno)
 4. crear canales que faltan
 5. propiedad de canales
 6. clientes
 7. conversaciones
 8. mensajes, seguimientos, registros IA
 9. 12 VERIFICACIONES → excepción si falla
10. NOT NULL + CHECKs
11. índices y unicidad
COMMIT
```

**El paso 2b es un fallo que encontró el ensayo, no la revisión.**
`conversations.clubId` seguía siendo `NOT NULL`, así que una conversación de
promoter no se podía insertar sin inventarle un club — justo lo que este cambio
viene a eliminar. Se relaja el NOT NULL sin borrar la columna. Relajarlo no toca
ni una fila existente.

---

## 3. SQL de rollback

`prisma/migrations/manual/001-channel-owner-rollback.sql`. Es posible **sin
pérdida de datos** porque la migración es aditiva: `clubId`, `channelType` y
`externalHandleHash` siguen intactos.

Empieza con un cortafuegos:

```sql
SELECT count(*) FROM conversations WHERE "ownerType" = 'PROMOTER';
-- si no es 0 → EXCEPTION: deshacer borraría conversaciones reales
```

Probado en las dos direcciones: se **niega** cuando hay datos de promoter, y en
una base sin ellos devuelve al estado original exacto — 3 conversaciones, 4
mensajes, 3 clientes, `clubId` otra vez `NOT NULL`, cero columnas nuestras
restantes.

---

## 4. Verificaciones

Doce, dentro de la transacción. Si una falla, `RAISE EXCEPTION` y `ROLLBACK`.

| # | Comprueba |
|---|---|
| 9.1 | Conversaciones, mensajes y clientes: mismo número antes y después |
| 9.2 | Nada sin `ownerType` (4 tablas) |
| 9.3 | Exactamente un dueño por fila (4 tablas) |
| 9.4 | `ownerClubId` == `clubId` legacy — nada cambió de tenant |
| 9.5 | Ningún cliente ni conversación sin canal |
| 9.6 | El dueño del cliente == el dueño de su canal |
| 9.7 | El dueño del mensaje == el de su conversación |
| 9.8 | Ningún `externalAccountId` duplicado dentro del mismo tipo |
| 9.9 | Ningún hash de cliente duplicado dentro del mismo canal |

**Probado que aborta:** con el relleno saboteado, la migración lanza
`ERROR: 3 conversaciones sin ownerType`, deshace todo y deja la base intacta —
cero columnas añadidas, 3 conversaciones donde había 3.

Para comprobar a mano después, sin depender del script:

```sql
SELECT count(*) FROM conversations;                                    -- igual que antes
SELECT count(*) FROM conversations WHERE "ownerType" IS NULL;          -- 0
SELECT count(*) FROM conversations
  WHERE "clubId" IS NOT NULL AND "ownerClubId" IS DISTINCT FROM "clubId";  -- 0
SELECT count(*) FROM customers WHERE "channelId" IS NULL;              -- 0
SELECT count(*) FROM messages m JOIN conversations cv ON cv.id = m."conversationId"
  WHERE m."ownerClubId" IS DISTINCT FROM cv."ownerClubId";             -- 0
```

---

## 5. RLS nuevo

`prisma/rls-owner.sql`. Las tablas se parten en dos grupos.

**Grupo 1 — solo de club** (events, ticket_types, vip_options, faqs,
brand_settings, ai_configs…): política de `rls.sql` sin cambios.

**Grupo 2 — dueño polimórfico** (channels, conversations, messages, customers,
follow_ups, ai_request_logs): política nueva con dos variables.

```sql
USING (
  ("ownerClubId" IS NOT NULL
     AND "ownerClubId" = current_setting('app.current_club_id', true))
  OR
  ("ownerPromoterId" IS NOT NULL
     AND "ownerPromoterId" = current_setting('app.current_promoter_id', true))
)
```

La comprobación `IS NOT NULL` no es decorativa: sin ella, `NULL = 'algo'` da
NULL, que no es verdadero, y una conversación de promoter sería invisible para
todos —incluido su dueño— **sin dar ningún error**.

**`contextClubId` no aparece en ninguna política.** Probado con un rol sin
BYPASSRLS:

| Quién mira | Qué ve |
|---|---|
| MON (club) | sus 2 conversaciones |
| MON, sobre la conversación privada de Javier con `contextClubId = MON` | **0 filas** |
| Javier (promoter) | su 1 conversación |
| Liberata (otro club) | solo la suya |
| Sin variable fijada | **0 filas** — falla cerrado |

Una sola variable por transacción. Fijar las dos haría que alguien con los dos
papeles viese filas de dos dueños en la misma consulta, que es justo lo que
estas políticas impiden.

---

## 6. `forTenant` → `forOwner`

```ts
type Owner =
  | { readonly type: "CLUB"; readonly clubId: string }
  | { readonly type: "PROMOTER"; readonly promoterId: string };

forOwner(principal, owner)
```

`forTenant(principal, clubId)` se queda como envoltura de
`forOwner(principal, {type:"CLUB", clubId})`, así que las once pantallas de club
que ya existen no se tocan. **El código nuevo de canales y conversaciones usa
`forOwner` directamente.**

Los repositorios que solo tienen sentido para un club (eventos, VIP, FAQs)
siguen exigiendo un dueño de tipo `CLUB` y fallan **en compilación** si se les
pasa un promoter.

`forOwner` es también quien fija la variable de sesión correcta —una, nunca
dos— antes de cada consulta.

La regla que no cambia: el dueño **nunca llega del frontend**. En el panel sale
de la sesión; en un webhook, del `Channel` resuelto por `externalAccountId`.

---

## 7. Tablas afectadas

| Tabla | Qué le pasa |
|---|---|
| `channels` | dueño polimórfico, `displayName`, `autoReply`, `waMode`, `tokenExpiresAt`; fuera `webhookSecret` |
| `conversations` | `owner*` + `contextClubId` + `locale`; `channelId` obligatorio |
| `customers` | dueño + `channelId` + `externalUserHash`/`externalUserRef` |
| `messages` | dueño denormalizado |
| `follow_ups` | dueño denormalizado |
| `ai_request_logs` | dueño denormalizado |
| `clubs`, `promoters` | solo relaciones inversas |
| eventos, VIP, FAQs… | **sin cambios** |

---

## 8. Qué se rellena y cómo

Todo lo que existe hoy pertenece a un club: no había canales de promoter.

| Dato | De dónde sale |
|---|---|
| `channels.ownerType` | `'CLUB'` |
| Canales que faltaban | Se **crean** desde `DISTINCT (clubId, channelType)` de `customers` |
| `customers.channelId` | Enlace por `(clubId, channelType)` |
| `customers.externalUserHash` | Copia de `externalHandleHash` |
| `customers.externalUserRef` | **NULL** — son de webchat, no hay dirección externa |
| `conversations.owner*` | `CLUB` + `clubId` |
| `conversations.contextClubId` | `clubId` — se hablaba de ese club |
| `conversations.channelId` | Enlace por `(clubId, channelType)` |
| `messages/follow_ups/ai_request_logs` | `CLUB` + `clubId` |

`promoterId` de las conversaciones **no se convierte en dueño**: marcaba por
quién llegó el cliente, no de quién era la conversación.

---

## 9. Riesgos

| Riesgo | Gravedad | Mitigación |
|---|---|---|
| `db push` ve el renombrado como borrar+crear y **vacía las conversaciones** | 🔴 Crítico | No se usa `db push`. Migración SQL manual |
| Clientes de clubs sin fila en `channels` | 🟠 Alto | El paso 4 los crea. **Probado** con un club en esa situación |
| RLS rompe en silencio con `ownerClubId` NULL | 🟠 Alto | `IS NOT NULL` explícito. **Probado** con rol sin BYPASSRLS |
| Dueño de mensaje divergente del de su conversación | 🟠 Alto | FK compuesta `(conversationId, ownerType)`. **Probado**: el insert incorrecto se rechaza |
| Un club lee los DMs de un RRPP por `contextClubId` | 🔴 Crítico | No entra en RLS. **Probado**: 0 filas |
| Canales desconectados chocando por `externalAccountId` NULL | 🟡 Medio | `NULLS DISTINCT`. **Probado**: dos entran |
| Migración a medias | 🟠 Alto | Transacción única + 12 verificaciones. **Probado** que aborta y deshace |
| El pooler corta un DDL largo | 🟡 Medio | Ejecutar con `DIRECT_URL` |

**Lo que la base de datos NO puede garantizar sola:** que el *id* concreto del
dueño de un mensaje coincida con el de su conversación. La FK compuesta cubre el
`ownerType`; el id lo cubren la aplicación (deriva el dueño de la conversación,
nunca de la petición) y la consulta 9.7, que conviene repasar de vez en cuando.
Una FK compuesta sobre columnas nullable usa `MATCH SIMPLE` y se saltaría la
comprobación en cuanto una fuese NULL.

---

## 10. Comprobar a mano que no se perdió nada

**Antes** de migrar:

```sql
SELECT count(*) AS conversaciones FROM conversations;
SELECT count(*) AS mensajes       FROM messages;
SELECT count(*) AS clientes       FROM customers;
SELECT "clubId", count(*) FROM conversations GROUP BY 1 ORDER BY 1;
```

Apunta los números.

**Después**, los mismos. Deben ser idénticos, y además:

```sql
-- Cada club conserva exactamente sus conversaciones.
SELECT "ownerClubId", count(*) FROM conversations GROUP BY 1 ORDER BY 1;
-- Ninguna cambió de dueño.
SELECT count(*) FROM conversations
 WHERE "clubId" IS NOT NULL AND "ownerClubId" IS DISTINCT FROM "clubId";  -- 0
```

Y en la interfaz: entra como club, abre Assistant y comprueba que las
conversaciones de siempre siguen ahí con sus mensajes.

Copia de seguridad antes (Supabase → Database → Backups). La migración va en
una transacción, así que un fallo no deja nada a medias — pero una copia cuesta
un minuto.

---

## 11. Qué queda legacy para el siguiente despliegue

Columnas que **se quedan** y no debe leer ningún código nuevo:

| Tabla | Columna |
|---|---|
| `conversations` | `clubId`, `promoterId` |
| `messages` | `clubId` |
| `customers` | `clubId`, `channelType`, `externalHandleHash` |
| `follow_ups` | `clubId` |
| `ai_request_logs` | `clubId` |

La migración **002** las eliminará. Antes hay que:

1. Comprobar por grep que ninguna consulta las usa.
2. Ejecutar la verificación 9.4 y confirmar cero divergencias.
3. Copia de seguridad.
4. Dejar pasar unos días con el código nuevo en marcha.

---

## Resultados del ensayo

Réplica del esquema actual con datos legacy: 2 clubs, 1 promoter, 3
conversaciones, 4 mensajes, 3 clientes, y **un club con clientes pero sin canal**.

| Prueba | Resultado |
|---|---|
| Migración completa | ✅ `Verificaciones superadas: 3 conversaciones, 4 mensajes, 3 clientes` |
| Canal creado para el club que no tenía | ✅ `ch_legacy_714a76…` |
| Canal de promoter | ✅ entra |
| Canal con dos dueños | ✅ rechazado por `channels_one_owner` |
| `ownerType` PROMOTER con `clubId` | ✅ rechazado |
| Dos canales desconectados, ambos con NULL | ✅ los dos entran |
| Misma cuenta de Instagram en otro canal | ✅ rechazado por unicidad |
| Mensaje con dueño divergente | ✅ rechazado por la FK compuesta |
| Conversación de promoter sin `clubId` legacy | ✅ entra |
| Migración saboteada | ✅ aborta y deshace, base intacta |
| Rollback con datos de promoter | ✅ se niega |
| Rollback en base limpia | ✅ vuelta exacta al estado original |
| RLS: MON no ve los DMs de Javier | ✅ 0 filas |
| RLS sin variable fijada | ✅ 0 filas |

---

# Addendum final: triggers, RLS, rol de aplicación y pooling

Reemplaza a la versión anterior de este apéndice. Todo lo de aquí está
ejecutado contra PostgreSQL 16 real, no revisado a ojo: la tubería completa
está en `scripts/pg-pipeline.sh` y sus resultados en `RESULTS.txt`.

## 12 · Rechazar o derivar: la regla y por qué

**Vacío → derivar. Igual → aceptar. Distinto → rechazar.**

| Opción | Puede quedar mal el dato | Se entera alguien | Falla en abierto |
|---|---|---|---|
| Derivar siempre | No | **No** | No |
| Rechazar siempre | No | Sí | **Sí**, si una ruta nueva olvida el owner |
| **Derivar si falta, rechazar si difiere** | No | Sí | No |

Derivar siempre es tentador porque es imposible de romper, pero se traga
los errores: un fallo que mande el owner equivocado nunca se ve, y un
intento malicioso tampoco deja rastro. Rechazar siempre obliga a cada
llamante a calcular el owner, y el día que alguien añada una ruta que se
olvide, revienta en producción.

La tercera es la única que no puede fallar en abierto **ni** callarse un
fallo.

**Aceptar el owner correcto cuando viene explícito no es un detalle
menor:** Prisma manda en el `UPDATE` todos los campos del objeto, no solo
los que cambiaron. Si reescribir el mismo owner fallara, cualquier
`conversation.update()` normal reventaría. Está cubierto por el caso A2.

## 13 · Los 16 triggers y las 7 funciones

| Tabla | Deriva de | Inmutable |
|---|---|---|
| `channels` | — (es la raíz) | `ownerType`, `clubId`, `promoterId` |
| `customers` | `channels` | owner + `channelId` |
| `conversations` | `channels` | owner + `channelId` |
| `messages` | `conversations` | owner + `conversationId` |
| `follow_ups` | `conversations` | owner + `conversationId` |
| `ai_request_logs` | `conversations` si la hay | owner + `conversationId` |

`contextClubId` **no** está en ninguna lista de inmutabilidad: es «de qué
se habla», y una conversación puede pasar de preguntar por MON a preguntar
por Liberata.

Los punteros al padre se congelan porque son la puerta trasera: no toco el
owner, muevo la fila a un canal de otro, y el owner deja de cuadrar sin que
ningún trigger se queje.

`ai_request_logs` sin `conversationId` es el único caso sin origen del que
derivar: el owner viene del contexto de servidor y, si no viene, se rechaza
en vez de inventarlo (casos D6 y D7).

### ¿Hay algún flujo legítimo que cambie de dueño?

**No.** Los tres candidatos y por qué no lo son:

- **Un RRPP deja un club.** No cambia nada de dueño: sus conversaciones
  siempre fueron suyas. Lo que cambia es `PromoterClub.status`.
- **Fusión de clubs.** No es una operación de aplicación: es una migración
  con su propio guion, que puede quitar el trigger, mover y volver a
  ponerlo, dejando registro.
- **Un canal cambia de manos.** Se desconecta y se vuelve a conectar. Crea
  filas nuevas, que es lo correcto: el historial del dueño anterior no debe
  viajar con la cuenta.

## 14 · Borrar un canal no destruye historial

`channels → customers` y `channels → conversations` son **NO ACTION**.

NO ACTION y no RESTRICT, y la diferencia importa: NO ACTION se comprueba al
final de la sentencia, así que si otro CASCADE de la misma sentencia ya
borró las filas hijas, pasa. RESTRICT se comprueba al instante y no da esa
oportunidad.

Eso es lo que permite las dos cosas a la vez:

- `DELETE FROM channels` con historial → **falla** (caso B1)
- `DELETE FROM promoters` → se lleva sus canales y su historial vía las FK
  de propiedad, y el NO ACTION del canal se satisface al final (caso B2)

Ambos comportamientos están probados.

## 15 · El rol `nl_app`

`app-role.sql` lo crea con todos los atributos en negativo y **sin
contraseña en el archivo**: se pasa como variable de psql.

Permisos concedidos tabla a tabla. Nada de `GRANT ... ON ALL TABLES` ni
`ALTER DEFAULT PRIVILEGES` global: una tabla nueva no debe volverse
accesible por el mero hecho de existir. Añadirla a la lista es el trámite
que fuerza la revisión.

Además revoca el CRUD de `anon` y `authenticated` sobre las seis tablas
internas. Esos son los roles de PostgREST: si tienen acceso, cualquiera con
la anon key puede consultarlas por HTTP sin pasar por nuestro código. Solo
se tocan esas seis; Auth y Storage se quedan como están.

**No se afirma nada sobre qué es el rol `postgres` de Supabase.**
`verification.sql` lee `pg_roles` y lista los roles con login que se saltan
RLS, sean los que sean en tu instalación.

## 16 · La trampa que casi se cuela: verificar sobre una vista vacía

Las políticas van `TO nl_app`. Con `FORCE ROW LEVEL SECURITY` activo, un
rol sin política —incluido el dueño de las tablas— ve **cero filas**.

Consecuencia: si `verification.sql` se ejecutara con una conexión sujeta a
RLS, todas sus comprobaciones de datos consultarían una vista vacía y
dirían «0 huérfanos, 0 divergencias, todo perfecto». Un informe en verde
sobre nada. Y peor: los `UPDATE` de relleno de la migración afectarían a
cero filas **sin dar ningún error**.

Los tres archivos (`001`, el rollback y `verification`) empiezan ahora
comprobando que su propia sesión no está filtrada, y abortan si lo está. La
detección: con `row_security = off`, Postgres lanza un error si la consulta
se vería afectada por alguna política. Superusuario o `BYPASSRLS` pasan; el
dueño con FORCE o cualquier rol normal revientan. Ese es el discriminante,
y está comprobado empíricamente.

## 17 · Las dos variables, siempre

`forOwner` fija **las dos** en cada transacción, la que no toca a cadena
vacía:

```ts
const clubId     = owner.type === "CLUB"     ? owner.clubId     : "";
const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";
await tx.$queryRaw`SELECT set_config('app.current_club_id',     ${clubId},     true)`;
await tx.$queryRaw`SELECT set_config('app.current_promoter_id', ${promoterId}, true)`;
```

No es simetría estética. Si el pooler entrega una conexión donde alguien
dejó `app.current_club_id` fijado **a nivel de sesión** —código viejo, un
script, un `SET` suelto—, no fijarla aquí significa heredarla. Ponerla
vacía la pisa dentro de la transacción.

Y la cadena vacía no puede conceder nada: un `ownerClubId` nunca es `''`.

El caso 7 de `rls-pooling-tests.sql` reproduce exactamente eso: ensucia la
conexión con `set_config(..., false)`, luego hace lo que hace
`forOwner(PROMOTER)`, y comprueba que el promoter ve **cero** filas del club
contaminado. El caso 8 es el contraejemplo que demuestra que la
contaminación era real.

`set_config()` y no `SET LOCAL` porque el segundo no admite parámetros y
habría que interpolar el id en la cadena SQL.

`forTenant()` se mantiene como puente: `forOwnerFromTenant(principal,
clubId)` es `forOwner(principal, {type:'CLUB', clubId})`. El código viejo
sigue funcionando y empieza a pasar por RLS sin tocar una línea.

## 18 · Un detalle que salió del ensayo

Las funciones de trigger **no son `SECURITY DEFINER`**, y es deliberado:
sus `SELECT` internos pasan también por las políticas. Efecto observado: un
RRPP que intenta colgar un mensaje de una conversación de club no recibe
«no es tuya» sino **«no existe»**, que es la respuesta correcta porque para
él no existe. Dos barreras por el precio de una.

`verification.sql` comprueba que ninguna se vuelva `SECURITY DEFINER` más
adelante.

**Cabo suelto para el bloque de Meta:** los webhooks entrantes no traen
dueño — llegan con un id de cuenta de Instagram y hay que *buscar* a qué
canal corresponde, sobre `channels`, que está bajo RLS, sin saber aún qué
variable fijar. Eso necesitará una función `SECURITY DEFINER` acotada: en
un esquema privado, con `search_path` fijo, que reciba `(tipo,
externalAccountId)` y devuelva **solo** el owner — nunca credenciales,
nunca un listado. No un bypass general, y desde luego no `BYPASSRLS` para
el webhook. Hoy no hace falta: no hay canales entrantes conectados.

## 19 · Resultados del ensayo completo

`scripts/pg-pipeline.sh`, 14 pasos, PostgreSQL 16 real:

| Paso | Resultado |
|---|---|
| Fixture legacy (incluye el RLS antiguo por `clubId`) | ✅ |
| `001-channel-owner.sql` | ✅ `Verificaciones superadas: 3 conversaciones, 4 mensajes, 3 clientes` |
| `app-role.sql` | ✅ rol creado con permisos mínimos |
| `rls-owner.sql` | ✅ 6 políticas `TO nl_app` |
| `trigger-tests.sql` (33 casos) | ✅ TODO VERDE |
| `rls-pooling-tests.sql` como `nl_app` (18 casos) | ✅ TODO VERDE |
| `verification.sql` (~55 comprobaciones) | ✅ 0 fallos |
| Rollback con datos de RRPP | ✅ **aborta**: «Hay 4 filas de promoter (channels: 1, customers: 1, conversations: 1, messages: 1)» |
| Rollback sin datos de RRPP | ✅ vuelta completa; 0 columnas nuevas, 0 triggers, 0 funciones, 6 políticas legacy restauradas |
| Filas tras la vuelta | ✅ 3/4/3/1/1 — idénticas al fixture |
| Reaplicar todo desde cero | ✅ |
| `verification` + las dos suites otra vez | ✅ |

### Fallos que encontró el ensayo y que la revisión no vio

- El caso D de la tanda anterior **falló**, y era mi test: puse `cv_1` al
  owner que ya tenía, así que el `UPDATE` era un no-op y pasaba con razón.
  Al reescribirlo salieron tres casos más, incluido el patrón de Prisma.
- `channels_promoter_type_key` hizo fallar la primera ejecución de
  `trigger-tests`: el seed y el test le daban a Javier dos canales de
  Instagram. Que el índice lo detectara es buena señal.
- Un falso «2 funciones sin borrar» tras el rollback: mi consulta usaba
  `LIKE 'nl_%'`, y en SQL el guion bajo es un comodín — casaba con
  `nlikesel`, una función interna de PostgreSQL. De ahí que
  `verification.sql` use listas exactas y no `LIKE`.
- El propio guion de la tubería daba un falso negativo en el paso del
  rollback: `grep -q` cierra la tubería antes de tiempo, psql recibe
  SIGPIPE y con `pipefail` la condición salía falsa aunque el mensaje
  estuviera.

## 20 · Estado

- 412 tests TypeScript verdes (365 → 412; 47 en `tests/rls-owner.test.ts`).
- `tsconfig.core.json` limpio.
- Tubería PostgreSQL: 14 pasos, todos verdes.
- Nada ejecutado contra Supabase. Ningún `db push`.
