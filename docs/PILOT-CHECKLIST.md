# Checklist del piloto

Para pasársela a cada tester y para comprobarlo tú antes de invitar a
nadie.

**Cómo marcar:** `[x]` funciona · `[!]` funciona a medias, con nota al lado
· `[ ]` no probado · `[✗]` roto.

Un `[!]` con una frase de explicación vale más que diez `[x]`. Lo que
buscamos en un piloto es lo que se rompe.

---

## Antes de invitar a nadie (lo compruebas tú)

- [ ] `verification.sql` dice «Todo correcto. 0 fallos.»
- [ ] `DATABASE_URL` usa `nl_app` (no el usuario administrador)
- [ ] `verification.sql` confirma `rolsuper = false` y `rolbypassrls = false`
- [ ] `npm run build` pasa en tu máquina
- [ ] `https://nightlife.team` carga
- [ ] Entrar con Google funciona en el dominio real, no solo en local
- [ ] Falta `LLM_API_KEY` → dice «Asistente no configurado» en vez de romperse
- [ ] Sin Meta configurado → Instagram y WhatsApp dicen «Integración pendiente»

---

## RRPP / Promoter

### Entrar

- [ ] Crear cuenta con email y contraseña
- [ ] Entrar con Google
- [ ] Un usuario que ya existía y vuelve por Google **no** se duplica
- [ ] Cerrar sesión de verdad (volver atrás no devuelve al panel)
- [ ] Elegir PROMOTER en el registro

### Onboarding

- [ ] Se completa entero desde el móvil
- [ ] Nombre y ciudad
- [ ] Se puede saltar lo opcional sin quedarse atascado
- [ ] Al terminar cae en su panel, no en una pantalla en blanco

### Perfil

- [ ] Editar nombre, bio, ciudad
- [ ] Subir avatar (jpg, png, webp — máx. 5 MB)
- [ ] Subir portada
- [ ] Reemplazar una foto ya subida (la anterior desaparece)
- [ ] Rechaza un archivo de más de 5 MB con un mensaje claro
- [ ] Interruptores de visibilidad: Instagram, WhatsApp, ciudad
- [ ] Lo que se oculta **no aparece** en el perfil público

### Fourvenues

- [ ] Pegar su enlace personal de Fourvenues
- [ ] Se guarda y se ve al volver
- [ ] Sin enlace: no se inventa ninguno

### Perfil público

- [ ] Se abre sin estar registrado
- [ ] Se ve bien en móvil (390 px)
- [ ] Portada, avatar, nombre
- [ ] Solo lo que marcó como visible
- [ ] Eventos próximos, si tiene
- [ ] Sin eventos: «Aún no tienes eventos», no una página vacía

### Eventos

- [ ] Se ven los eventos reales que le corresponden
- [ ] **No** aparecen eventos de clubs con los que no trabaja
- [ ] Al tocar un evento se abre el Fourvenues correcto
- [ ] Sin URL específica, cae en su enlace personal
- [ ] Sin ninguna URL: no se inventa un enlace

### Asistente (webchat)

- [ ] Se abre desde su perfil público
- [ ] «qué tienes el sábado?» → sus eventos reales
- [ ] «la de MON» → mantiene el contexto
- [ ] «cuánto?» → precio real, sin volver a preguntar de qué evento
- [ ] «link» → Fourvenues correcto
- [ ] «how much tonight?» → responde en inglés
- [ ] Algo que no sabe → **no se lo inventa**

### Conocimiento

- [ ] Añadir información propia
- [ ] Añadir FAQs
- [ ] «puedo ir en shorts?» encuentra la FAQ de «pantalón corto»
- [ ] Su información **no** contradice la oficial del club

### Preguntas sin respuesta

- [ ] Preguntar algo que nadie ha configurado
- [ ] La IA no se lo inventa
- [ ] Aparece en «Preguntas sin respuesta»
- [ ] Se puede responder desde ahí
- [ ] La misma pregunta, dicha de otra forma, ya se contesta sola

### Handoff

- [ ] «quiero hablar con alguien» → pasa a esperando humano
- [ ] Aparece en el panel
- [ ] Al aceptarla, **la IA se calla**
- [ ] Se puede devolver a la IA

### Móvil

- [ ] Navegación inferior: Inicio, Eventos, Perfil, Más
- [ ] Nada se sale por el lado
- [ ] Los botones se pulsan bien con el dedo (44 px o más)
- [ ] Las ventanas emergentes se pueden cerrar

### Feedback

- [ ] Encuentra dónde reportar un error
- [ ] Lo envía y recibe confirmación

---

## Discoteca / Club

### Entrar y onboarding

- [ ] Crear cuenta y elegir CLUB
- [ ] Nombre, ciudad, dirección
- [ ] Logo y portada opcionales
- [ ] **No** se queda bloqueado porque Meta no esté conectado

### Branding

- [ ] Logo y portada
- [ ] Se ven en el perfil público

### Fourvenues

- [ ] Pegar la API key
- [ ] Se valida contra Fourvenues de verdad
- [ ] Aparecen sus venues
- [ ] Elegir venue si hay varios
- [ ] Los eventos se importan
- [ ] **La API key no vuelve a mostrarse** en pantalla ni en el código de la página
- [ ] Key inválida → mensaje humano, no un error técnico

### Eventos

- [ ] Solo eventos de ese club
- [ ] Precio: la tarifa vigente ahora, no el mínimo histórico
- [ ] Sin conectar: «Conecta Fourvenues para importar tus eventos»

### Conocimiento

- [ ] Edad mínima, dress code, horario, ubicación, VIP, cumpleaños, guest list
- [ ] FAQs libres
- [ ] Un evento concreto puede **sobrescribir** lo general (ej. +21 en vez de +18)

### Asistente

- [ ] «qué hay hoy?» → eventos reales
- [ ] «precio?» → precio real
- [ ] «edad?» → su información oficial
- [ ] «puedo ir con deportivas?» → su dress code
- [ ] «somos 10 y queremos mesa» → VIP o handoff
- [ ] Algo desconocido → no se lo inventa

### Conversaciones

- [ ] Se ven las recientes
- [ ] Se distingue el canal (Instagram / WhatsApp / Web)
- [ ] Se ven las que esperan humano

### Móvil

- [ ] Navegación inferior: Inicio, Eventos, Asistente, Más
- [ ] **No** aparece «Promoters» en la navegación

---

## Seguridad (esto lo compruebas tú, no un tester)

Es la parte que no se puede dejar para después.

- [ ] Club A no ve ninguna conversación de Club B
- [ ] RRPP A no ve ninguna conversación de RRPP B
- [ ] Un club **no** ve los DMs privados de un RRPP, ni siquiera cuando en
      esa conversación se habló de ese club
- [ ] Un RRPP no ve las conversaciones de ningún club
- [ ] Cerrar sesión y volver atrás no devuelve al panel
- [ ] Las páginas públicas no exponen conversaciones, credenciales ni
      identidades de clientes

Las cuatro primeras ya están probadas en la base de datos
(`rls-pooling-tests.sql`, 18 casos verdes). Lo que se comprueba aquí es que
la aplicación no las esquiva por otro camino.

---

## Qué preguntarle a cada tester al final

Cuatro preguntas. Más de cuatro y no contesta ninguna.

1. ¿En qué momento te has quedado sin saber qué hacer?
2. ¿Qué le preguntó un cliente que la IA no supo responder?
3. ¿Qué esperabas encontrar y no estaba?
4. ¿Lo usarías el sábado que viene? ¿Por qué no?
