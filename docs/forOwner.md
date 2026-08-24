# `forOwner()` — implementación exacta

> **Dónde vive este código.** Todavía no está en `src/`, y es a propósito:
> `tsconfig.json` incluye `**/*.ts`, y las columnas `ownerType` /
> `ownerClubId` / `ownerPromoterId` aún no existen en `schema.prisma`, así
> que el cliente de Prisma no las conoce y `npm run typecheck` daría error.
>
> Este archivo se mueve a `src/packages/db/owner.ts` **en el mismo commit**
> que el cambio de `schema.prisma`, ni antes ni después.

---

## Las dos piezas y por qué hacen falta las dos

Postgres no sabe quién es «el usuario actual» a efectos de RLS. Se lo
decimos con una variable, y las políticas la leen. El problema es que en
producción **las conexiones se reutilizan**: Supabase pone un pooler
delante, y la conexión que atendió al Club A atiende luego al Promoter B.

| Pieza | Qué resuelve | Qué pasa sin ella |
|---|---|---|
| `prisma.$transaction(fn)` | Todo va por **una** conexión, y el pooler la reserva entera mientras dura la transacción | Dos consultas seguidas pueden salir por conexiones distintas; la segunda no ve la variable y devuelve **cero filas** sin error |
| `set_config(nombre, valor, true)` | El tercer argumento: `true` = **local a la transacción**. Postgres lo revierte solo al COMMIT o al ROLLBACK | La variable se queda pegada a la conexión. El siguiente inquilino que la reciba **hereda el club anterior** y lee datos ajenos, sin error ninguno |
| Fijar **las dos** variables, la que no toca a `''` | Pisa una variable que alguien dejara fijada a nivel de sesión en esa conexión | Un RRPP atendido por una conexión donde quedó `app.current_club_id='club_mon'` vería las conversaciones de MON |

No hay ningún `RESET` que se pueda olvidar ni un `finally` que se salte una
excepción. Lo deshace el motor.

## Por qué no `SET LOCAL`

`SET LOCAL app.current_club_id = '<id>'` haría lo mismo, pero **no admite
parámetros**: habría que interpolar el id en la cadena SQL. `set_config()`
es una función normal, así que acepta `$1` y `$2` y un id con comillas no
puede convertirse en SQL.

## El propietario nunca viene del frontend

`ownerFor()` toma el `Principal` ya autenticado y comprueba la pertenencia
antes de devolver nada. Un `ownerId` que llegue en el body de una petición
es, como mucho, una sugerencia; aquí ni se mira.

## El `where` de aplicación es redundante a propósito

RLS ya filtra. El `where` de Prisma vuelve a filtrar. Es deliberado: si
alguien ejecuta este código contra una conexión sin políticas —una
migración, un script con el rol dueño de las tablas, un `DIRECT_URL`
despistado— el filtro sigue puesto.

## Requisito que invalida todo lo demás si falta

RLS **no se aplica** a un superusuario ni a un rol con `BYPASSRLS`. La
`DATABASE_URL` que trae Supabase por defecto usa `postgres`, que es
superusuario. Con esa cadena de conexión, este archivo y todas las
políticas son decorativos.

```sql
CREATE ROLE nl_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
GRANT USAGE ON SCHEMA public TO nl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nl_app;
```

`DATABASE_URL` → `nl_app` (aplicación, con políticas).
`DIRECT_URL` → `postgres` (migraciones, sin políticas, a propósito).

`verification.sql` lista los roles con login que se saltan RLS para poder
comprobarlo de un vistazo.

## Un cabo suelto que hay que resolver antes de conectar Meta

Los webhooks entrantes no traen dueño: llegan con un id de cuenta de
Instagram y hay que **buscar** a qué canal corresponde. Esa búsqueda es
sobre `channels`, que está bajo RLS, y en ese momento todavía no sabemos
qué variable fijar — así que devolvería cero filas.

El webhook necesita, por tanto, una función de resolución con privilegio
acotado: una `SECURITY DEFINER` que reciba `(tipo, externalAccountId)` y
devuelva **solo** el owner, nada más. No un bypass general de RLS. Queda
apuntado para cuando toque el bloque de Meta; hoy no hace falta porque no
hay canales entrantes conectados.

---

## El código

```ts
import { AppError } from "@nightlife/core/errors";
import type { Principal } from "@nightlife/core/rbac";
import { prisma } from "./client";

/**
 * Acceso a datos con propietario polimórfico + RLS.
 *
 * `forTenant` sirve para lo que siempre es de un club: eventos, entradas,
 * FAQs. Esto sirve para lo que puede ser de un club **o** de un RRPP: canales,
 * conversaciones, mensajes, clientes.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POR QUÉ TODO VA DENTRO DE UNA TRANSACCIÓN
 *
 * Postgres no tiene «el usuario actual» para RLS: se lo decimos nosotros con
 * una variable de sesión, y las políticas la leen. El problema es que en
 * producción las conexiones **se reutilizan**: Supabase pone un pooler
 * delante, y la conexión que atendió la petición del Club A atiende después
 * la del Promoter B.
 *
 * Si la variable se fijara a nivel de sesión, se quedaría pegada a esa
 * conexión. El Promoter B heredaría el club del A y leería sus
 * conversaciones. No daría ningún error: devolvería datos ajenos con toda
 * naturalidad.
 *
 * De ahí las dos piezas, que solo funcionan juntas:
 *
 *   1. `prisma.$transaction(fn)` — transacción interactiva. Todo lo de dentro
 *      va por UNA conexión, y el pooler la reserva entera para nosotros
 *      mientras dura (modo transacción). Sin esto, dos consultas seguidas
 *      pueden salir por conexiones distintas y la segunda no vería la
 *      variable.
 *
 *   2. `set_config(nombre, valor, true)` — ese tercer argumento es lo
 *      importante. `true` = LOCAL a la transacción: Postgres lo revierte solo
 *      al hacer COMMIT o ROLLBACK, pase lo que pase. Con `false` la variable
 *      sobrevive en la conexión y vuelve el problema de arriba.
 *
 * No hay ningún `RESET` que se nos pueda olvidar, ni un `finally` que se
 * salte una excepción. Lo deshace el motor.
 * ─────────────────────────────────────────────────────────────────────
 */

export type Owner =
  | { readonly type: "CLUB"; readonly clubId: string }
  | { readonly type: "PROMOTER"; readonly promoterId: string };

/** Cliente dentro de la transacción: es Prisma sin `$transaction` anidado. */
export type OwnerTx = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * El propietario NUNCA viene del frontend.
 *
 * Se deriva del Principal ya autenticado. Un `ownerId` que llegue en el body
 * de una petición es, como mucho, una sugerencia que hay que comprobar; aquí
 * ni se mira.
 */
export function ownerFor(principal: Principal, requested: Owner): Owner {
  if (requested.type === "CLUB") {
    // Pertenecer al club es condición para actuar en su nombre.
    if (!principal.clubRoles.has(requested.clubId)) throw AppError.notFound("Club");
    return requested;
  }
  // Un RRPP solo puede ser dueño de lo suyo. No hay «promoter admin».
  if (principal.promoterId !== requested.promoterId) throw AppError.notFound("Promoter");
  return requested;
}

/**
 * Fija la variable de RLS que toca y ejecuta el trabajo.
 *
 * Se fija UNA sola. Nunca las dos: alguien que es dueño de club y RRPP a la
 * vez vería en una misma consulta filas de dos dueños distintos, que es justo
 * lo que las políticas existen para impedir.
 */
export function withOwnerRls<T>(owner: Owner, work: (tx: OwnerTx) => Promise<T>): Promise<T> {
  // SIEMPRE las dos. La que no toca se pone a cadena vacía, no se deja sin
  // tocar: si el pooler nos entrega una conexión donde alguien dejó
  // `app.current_club_id` fijado A NIVEL DE SESIÓN (código viejo, un script,
  // un `SET` suelto), no fijarla aquí significaría heredarla. Ponerla vacía
  // la pisa dentro de esta transacción.
  //
  // Y la cadena vacía no puede conceder nada: un `ownerClubId` nunca es '',
  // así que `'' = ''` no llega a compararse con ninguna fila real — el
  // `IS NOT NULL` de la política descarta los nulos y la igualdad hace el
  // resto.
  const clubId     = owner.type === "CLUB"     ? owner.clubId     : "";
  const promoterId = owner.type === "PROMOTER" ? owner.promoterId : "";

  return prisma.$transaction(async (tx) => {
    // Parametrizado, no interpolado: `SET LOCAL` no acepta parámetros, pero
    // `set_config()` es una función normal y sí. Un id con comillas no puede
    // convertirse en SQL.
    //
    // El tercer argumento, `true`, es local a la transacción: Postgres lo
    // revierte solo al COMMIT o al ROLLBACK. Con `false` la variable
    // sobreviviría en la conexión y volvería el problema de arriba.
    await tx.$queryRaw`SELECT set_config('app.current_club_id',     ${clubId},     true)`;
    await tx.$queryRaw`SELECT set_config('app.current_promoter_id', ${promoterId}, true)`;
    return work(tx);
  });
}

/**
 * La cara pública: repositorio con el dueño incrustado.
 *
 * Igual que `forTenant`, no expone un `prisma` suelto. Cada método abre su
 * transacción, fija la variable y la suelta.
 */
export function forOwner(principal: Principal, requested: Owner) {
  const owner = ownerFor(principal, requested);

  /** El where de aplicación. Redundante con RLS **a propósito**: si alguien
   *  ejecuta esto contra una conexión sin políticas (una migración, un script
   *  con el rol dueño de la tabla), el filtro sigue puesto. */
  const where =
    owner.type === "CLUB"
      ? ({ ownerType: "CLUB" as const, ownerClubId: owner.clubId })
      : ({ ownerType: "PROMOTER" as const, ownerPromoterId: owner.promoterId });

  const channelWhere =
    owner.type === "CLUB"
      ? ({ ownerType: "CLUB" as const, clubId: owner.clubId })
      : ({ ownerType: "PROMOTER" as const, promoterId: owner.promoterId });

  return {
    owner,
    principal,

    channels: {
      list: () =>
        withOwnerRls(owner, (tx) =>
          tx.channel.findMany({ where: channelWhere, orderBy: { type: "asc" } }),
        ),
    },

    conversations: {
      list: (status?: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.findMany({
            where: { ...where, ...(status ? { status: status as never } : {}) },
            orderBy: { lastMessageAt: "desc" },
            take: 100,
          }),
        ),

      get: (conversationId: string) =>
        withOwnerRls(owner, (tx) =>
          tx.conversation.findFirst({
            where: { id: conversationId, ...where },
            include: { messages: { orderBy: { createdAt: "asc" }, take: 50 } },
          }),
        ),
    },

    customers: {
      list: () => withOwnerRls(owner, (tx) => tx.customer.findMany({ where, take: 200 })),
    },

    /**
     * Para operaciones que tocan varias tablas y deben ir juntas. Es el único
     * hueco por el que sale el cliente crudo, y solo dentro de la transacción
     * con la variable ya fijada.
     */
    tx: <T>(work: (tx: OwnerTx) => Promise<T>) => withOwnerRls(owner, work),
  };
}

export type OwnerDb = ReturnType<typeof forOwner>;

/**
 * Puente legacy.
 *
 * `forTenant(principal, clubId)` es lo que usa todo el código actual. Aquí
 * no se reescribe: se le pone delante `forOwner` con dueño de tipo CLUB, que
 * es exactamente lo que significaba. El código viejo sigue funcionando y
 * empieza a pasar por RLS sin tocar una línea.
 *
 * El código nuevo llama a `forOwner` directamente. Este wrapper desaparece
 * cuando no quede ningún llamante.
 */
export function forOwnerFromTenant(principal: Principal, clubId: string) {
  return forOwner(principal, { type: "CLUB", clubId });
}
```
