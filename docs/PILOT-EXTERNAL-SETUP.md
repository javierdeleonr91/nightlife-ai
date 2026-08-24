# Configuración externa para el piloto

Tres columnas: lo que ya funciona, lo que depende de ti, y lo que depende
de que un tercero te apruebe algo. La tercera es la que marca la fecha real
del piloto, así que empieza por ella aunque parezca lo menos urgente.

---

## A · YA FUNCIONA (probado)

Probado significa ejecutado, no revisado a ojo. El detalle está en
`RESULTS.txt`.

| Qué | Estado | Cómo se comprobó |
|---|---|---|
| Migración de propiedad polimórfica | ✅ | Ejecutada entera contra PostgreSQL 16 real, dos veces |
| Triggers de propiedad (16) | ✅ | 33 casos en `trigger-tests.sql`, todos verdes |
| Aislamiento RLS entre inquilinos | ✅ | 18 casos como `nl_app`, incluida contaminación de conexión |
| Rol `nl_app` con permisos mínimos | ✅ | `verification.sql` lee `pg_roles` y los privilegios reales |
| Rollback con cortafuegos | ✅ | Aborta con datos de RRPP; vuelta completa al esquema legacy |
| Núcleo de dominio TypeScript | ✅ | 412 tests, `tsc` limpio sobre `tsconfig.core.json` |
| Lógica OAuth (Google) | ✅ | 51 tests unitarios sobre PKCE, vinculación y destino |

---

## B · REQUIERE ACCIÓN TUYA

### B1 · Desplegar la base de datos

`docs/PASOS-PARA-JAVIER.md`, pasos 1 a 10. Media hora larga, todo desde el
navegador. Es lo primero.

### B2 · Instalar dependencias y compilar

Esto lo tengo que dejar en tus manos: en mi entorno el registro de npm
devuelve 403 para todos los registros, así que no he podido ejecutar
`npm install` ni nada que dependa de ello.

En tu máquina, en la carpeta del proyecto:

```
npm install
npx prisma generate
npm run typecheck
npm run build
```

Si `typecheck` o `build` fallan, mándame la salida entera. Es información
que aquí no puedo obtener de ninguna otra forma.

**No ejecutes `npm audit fix --force`.** Rompe versiones sin avisar.

### B3 · Dominio y despliegue

- Apuntar `nightlife.team` al hosting.
- `APP_URL=https://nightlife.team` en las variables del hosting.
- Comprobar que no queda ningún `localhost` codificado a mano en el código
  de producción.

### B4 · Google OAuth en producción

En Google Cloud Console → Credentials → tu OAuth Client:

- **Authorized redirect URI**: añadir
  `https://<tu-proyecto>.supabase.co/auth/v1/callback`
- En Supabase → Authentication → URL Configuration:
  - Site URL: `https://nightlife.team`
  - Redirect URLs: `https://nightlife.team/auth/callback`

Deja también `http://localhost:3000/auth/callback` si quieres seguir
probando en local.

### B5 · Clave del modelo de lenguaje

`LLM_API_KEY` en las variables del hosting. Sin ella el asistente no
funciona — y **no debe fingir que funciona**: la interfaz tiene que decir
«Asistente no configurado» y el resto del producto seguir operativo.

### B6 · Clave de API de Fourvenues (por club)

No es una clave tuya: cada club conecta la suya desde su propio panel. Lo
que necesitas tú es que exista `NIGHTLIFE_SECRET_KEY` en el hosting, que es
con lo que se cifran esas claves antes de guardarlas.

Base de la API: `https://api-alpha.fourvenues.com/integrations`,
cabecera `X-Api-Key`.

### B7 · Almacenamiento

El bucket `profile-media` en Supabase Storage. Si ya existe, nada que
hacer. `SUPABASE_SERVICE_ROLE_KEY` solo en el servidor, nunca con prefijo
`NEXT_PUBLIC_`.

---

## C · REQUIERE APROBACIÓN EXTERNA

Aquí no manda nadie de nosotros. Los plazos son de Meta y de Apple.

### C1 · Meta — Instagram Messaging

1. https://developers.facebook.com → crear una App de tipo **Business**.
2. Añadir el producto **Instagram** → *Instagram API setup with Instagram
   login* o *with Facebook login*, según cómo tengan montadas las cuentas
   los clubs.
3. Permisos que hay que pedir en App Review:
   `instagram_business_basic`, `instagram_business_manage_messages`.
4. **App Review**: Meta pide un vídeo mostrando el flujo completo y una
   política de privacidad publicada en el dominio. Suele tardar días, a
   veces semanas.

**Requisito del lado del cliente:** la cuenta de Instagram tiene que ser
**Business** o **Creator**. Una cuenta personal no puede conectarse — no es
una limitación nuestra, es de la API. La interfaz debe decirlo con esas
palabras, no fallar en silencio.

### C2 · Meta — WhatsApp Cloud API

1. En la misma App, añadir el producto **WhatsApp**.
2. Crear una cuenta de WhatsApp Business (WABA).
3. Registrar el número y verificar el negocio.

Sobre el número, que es la duda que sale siempre:

- **Ya usa la app de WhatsApp Business** (versión 2.24.17 o posterior):
  existe **coexistencia**. Se conserva el número, la app y el historial. Lo
  que se pierde mientras está en coexistencia: mensajes temporales, ver una
  vez, ubicación en tiempo real, listas de difusión y grupos. Límite de 20
  mensajes por segundo.
- **Usa WhatsApp normal**: puede pasarse a WhatsApp Business gratis, sin
  cambiar de número.
- **Número nuevo**: onboarding aparte, sin historial previo.

**No damos por hecho que haga falta un segundo número.** Se pregunta qué
tiene cada uno y se le guía desde ahí.

### C3 · Apple Sign In — opcional, no bloquea

Si no está configurado, el botón se oculta o se deja deshabilitado. Nada de
botones decorativos que no hacen nada.

Si algún día lo activas: el *client secret* de Apple **caduca cada 6 meses
y hay que regenerarlo a mano**. Supabase no lo rota solo. El procedimiento
está en `docs/apple-secret-rotation.md`; pon un recordatorio en el
calendario el día que lo configures.

---

## D · Cómo se degrada cuando falta algo

Que falte una integración no puede tumbar el producto. Este es el
comportamiento correcto:

| Falta | Qué pasa |
|---|---|
| `LLM_API_KEY` | «Asistente no configurado». Todo lo demás funciona |
| App de Meta | Instagram y WhatsApp: «Integración pendiente». El resto funciona |
| Fourvenues del club | «Conecta Fourvenues para importar tus eventos». No se inventan eventos |
| Apple | Botón oculto. Google y email siguen |
| Storage | Se puede editar el perfil sin foto |
| **Base de datos** | Esto sí es crítico: sin `DATABASE_URL` no arranca, y debe decirlo claro |

---

## E · Orden recomendado

1. **Hoy** — C1 y C2: abrir la App de Meta y mandar App Review. Es lo que
   más tarda y no depende de nada nuestro. Cuanto antes empiece el reloj,
   mejor.
2. **Hoy** — B1: desplegar la base de datos.
3. **Después** — B2: instalar y compilar, y mandarme la salida si falla.
4. **Después** — B3, B4, B5.
5. **Cuando Meta conteste** — conectar Instagram y WhatsApp.

Mientras Meta responde, el webchat permite probar el asistente completo. Es
justo para eso: para no tener el producto parado esperando a un tercero.
