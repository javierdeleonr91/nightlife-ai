# Rotar el client secret de Apple — cada 6 meses

**Esto no se rota solo.** La documentación de Supabase lo dice sin rodeos:
*"Apple requires you to generate a new secret key every 6 months using the
signing key (.p8 file)"*, y recomienda ponerse un recordatorio en el calendario.

Si se pasa la fecha, «Continuar con Apple» deja de funcionar. El error que ve la
persona no menciona nada de secretos caducados, así que desde fuera parece que
el login está roto sin motivo. Es el tipo de avería que cuesta media mañana
diagnosticar seis meses después de haberla configurado.

Google no tiene este problema: su client secret no caduca.

## Recordatorio

Ponlo el día que configures Apple por primera vez:

- **Cada 5 meses** (no 6 — deja margen), evento recurrente en el calendario.
- Título sugerido: *"Rotar client secret de Apple — Nightlife"*.
- Enlaza este archivo en la descripción del evento.

## Qué hace falta a mano

Tres datos y un archivo. Los tres datos no cambian entre rotaciones; el archivo
tampoco: el `.p8` sirve para generar secretos nuevos indefinidamente.

| Dato | Dónde está |
|---|---|
| Services ID | Apple Developer → Identifiers → Services IDs |
| Team ID | Apple Developer, arriba a la derecha |
| Key ID | Apple Developer → Keys → la key de Sign in with Apple |
| Archivo `.p8` | Se descargó al crear la key. **Solo se puede descargar una vez.** |

## El procedimiento

1. Abre **Supabase → Authentication → Providers → Apple**.
2. Usa la herramienta de generación de secret que trae esa misma pantalla:
   pega el contenido del `.p8` y los tres identificadores.
3. Guarda. El secreto nuevo sustituye al anterior.
4. Comprueba el acceso con Apple en producción antes de dar la tarea por hecha.
   Un secreto mal pegado no falla al guardarlo: falla al usarlo.

## Dónde vive el `.p8`

En un gestor de contraseñas o en un secret manager. **Nunca**:

- en el repositorio — hay una regla en `.gitignore` que lo impide, pero la
  regla no cubre renombrarlo;
- en `.env`, ni con prefijo `NEXT_PUBLIC_` ni sin él;
- en un mensaje de Slack ni en un email.

Si se pierde, no se puede volver a descargar: hay que revocar la key en Apple y
crear otra, lo cual invalida el secreto vigente y tira abajo el acceso con Apple
hasta que se configure el nuevo.

## Si ya ha caducado

El síntoma es que Apple devuelve `invalid_client` y nuestro callback acaba en
`/login?error=oauth`. Se arregla generando un secreto nuevo con el procedimiento
de arriba: no hace falta tocar nada en el código ni volver a desplegar, y las
sesiones que ya estaban abiertas siguen funcionando — nuestra sesión es propia y
no depende de Apple una vez emitida.
