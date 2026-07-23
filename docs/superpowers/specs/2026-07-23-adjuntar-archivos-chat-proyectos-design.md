# Adjuntar archivos al chat de Proyectos — Diseño

**Fecha:** 2026-07-23
**Estado:** Aprobado, listo para plan de implementación

## Objetivo

Permitir que las personas adjunten archivos en el chat del workspace de un
proyecto (`front/src/pages/ProjectWorkspace.jsx`) para que el agente de
desarrollo los use durante el desarrollo de la app:

- **Referencias visuales** — mockups, screenshots de un diseño a replicar o de un bug.
- **Datos** — CSV / JSON / Excel que la app tiene que consumir o mostrar.
- **Documentos / specs** — PDF o texto con requerimientos que guíen el desarrollo.
- **Assets** — logos, íconos, imágenes que la app va a usar.

Hoy el chat de Proyectos **solo manda texto**. El chat normal (`Chat.jsx` +
`proxy.js /completions`) ya soporta adjuntos, pero el workspace no.

## Enfoque elegido: híbrido (materializar + multimodal)

Los adjuntos se resuelven en dos planos a la vez:

1. **Materialización en el filesystem del pod.** Todos los archivos se escriben
   en `/workspace/.attachments/` dentro del repo clonado. Así el agente puede
   leerlos con `read_file`, referenciarlos y —como todo lo del workspace se
   commitea con `git_push` (`git add -A`)— **quedan en el repo**.
2. **Multimodal para lo visual.** Imágenes y PDF se pasan además al LLM como
   `image_url` (base64) para que el agente *vea* la referencia mientras desarrolla.
   (El `write_file` del agente es solo texto, por eso los binarios necesitan
   materializarse aparte: no se pueden "escribir" desde el LLM.)

Descartado: enfoque inline puro (como el chat normal) — no permite conservar
assets binarios en el repo y explota el contexto del LLM con archivos grandes en
cada ronda de tools.

## Decisión de persistencia

**Todo queda en el repo.** Los adjuntos se escriben en `.attachments/` y se
commitean tal cual al hacer `git_push`. No hay `.gitignore` selectivo ni marcado
manual de "esto es asset / esto es referencia": el agente usa los archivos según
lo que se le pida (leer datos, replicar un diseño, referenciar un logo) y el
push arrastra `.attachments/` junto con los cambios de código.

## Flujo de datos

```
Front (archivos → base64 en estado)
  → api.streamMessage(chatId, model, messages, connectors, projectId, attachments)
  → back POST /api/chat/stream   (nuevo campo top-level `attachments`)
  → handleWorkspaceStream:
        - guarda el mensaje de usuario en DB con refs [📎 nombre]
        - POST pod http://{podIP}:3200/chat { message, history, attachments }
  → pod /chat:
        - writeAttachments(): decodifica base64 y escribe en /workspace/.attachments/<nombre saneado>
        - pasa metadata (nombre, mimeType, ruta) a runAgent
  → runAgent arma el primer mensaje de usuario:
        - texto: pedido + nota con rutas de los adjuntos
        - image_url (base64) para tipos visibles (jpeg/png/gif/webp/pdf)
  → el LLM ve las imágenes y conoce las rutas
  → el agente lee datos con read_file / referencia assets / desarrolla
  → git_push → `git add -A` commitea .attachments/ + el código nuevo
```

## Componentes y cambios

### 1. Frontend — `front/src/pages/ProjectWorkspace.jsx`

- Portar la lógica de adjuntos existente en `Chat.jsx`:
  - Botón de clip + `<input type="file">` (mismo `accept` que el chat).
  - Lectura a base64 (`FileReader.readAsDataURL`) para binarios; lectura de
    texto para tipos de texto (igual criterio que `Chat.jsx`).
  - Estado `attachments`, chips de preview con thumbnail y botón para quitar.
- `doSend`: envía `text` + `attachments`. Habilita el envío si hay **texto o
  adjuntos** (hoy exige texto).
- El mensaje del usuario en el historial muestra texto + chips/miniaturas
  (reusar el patrón `.msg-attached-img` de `Chat.jsx`).
- Validación en front: máx **5 archivos**, máx **10 MB por archivo**; aviso claro
  si se excede.

### 2. API client — `front/src/lib/api.js`

- `streamMessage(...)` suma un parámetro `attachments` que se incluye en el body
  del POST a `/api/chat/stream`.

### 3. Backend — `back/src/routes/proxy.js`

- `/stream` y `handleWorkspaceStream` reciben `attachments` (array top-level,
  aparte de `messages`).
- Guardar el mensaje de usuario en DB con las referencias `[📎 nombre]`
  (usar / extender `extractTextForDb`).
- Reenviar `attachments` al pod en el body del POST `/chat`.
- Subir el límite de `express.json` en el back para tolerar los base64
  (ver "Constraint técnico").

### 4. Session-agent — `session-agent/src/`

- **Nuevo módulo `attachments.js`**: `writeAttachments(list)` decodifica base64 y
  escribe cada archivo en `/workspace/.attachments/<nombre saneado>`.
  - Sanea el nombre y bloquea path traversal reusando el criterio de `safePath`.
  - Resuelve colisiones de nombre (sufijo incremental).
  - Devuelve la lista con `{ name, mimeType, path }` para el agente.
- **`index.js` `/chat`**: recibe `attachments`, los escribe **antes** de correr el
  agente y pasa la metadata a `runAgent`. Sube el `express.json({ limit })`
  (hoy `10mb`).
- **`agent.js` `runAgent`**: acepta `attachments` y arma el `content` del primer
  mensaje de usuario:
  - Parte texto: el pedido del usuario + nota
    *"Archivos adjuntos disponibles: `.attachments/mockup.png` (imagen),
    `.attachments/datos.csv` (csv). Usalos según corresponda."*
  - Para MIME visibles por Claude (jpeg/png/gif/webp/pdf): parte `image_url`
    con el base64.
  - Los demás tipos (csv/txt/json/…): solo la nota con la ruta → el agente los
    abre con `read_file`.
  - El mensaje con imágenes queda **antes** del primer round de tools, así
    `pruneToolRounds` lo preserva a lo largo de la sesión.
- **`SYSTEM_PROMPT`**: agregar una sección que explique que los adjuntos viven en
  `.attachments/`, que las imágenes/PDF ya son visibles, que datos/texto se leen
  con `read_file`, y que todo el workspace (incluido `.attachments/`) se commitea
  con `git_push`.

## Manejo de errores

- **Archivo demasiado grande o demasiados archivos** → validación en front +
  guard en back; se emite un evento `error` sin romper el stream.
- **MIME no soportado por Claude** → solo se envían como `image_url` los tipos
  jpeg/png/gif/webp/pdf; el resto se materializa pero no va al LLM como imagen
  (se evita el error "Unsupported MIME type").
- **base64 inválido o fallo de escritura** → se saltea ese archivo con warning;
  el resto continúa.
- **Path traversal** → bloqueado por el saneo de nombre dentro de `.attachments/`.

## Constraint técnico

El base64 viaja front → back → pod. Hay que **subir el límite de body** en el
`express.json` del back y del pod para acomodar los adjuntos. Propuesta: ~25 MB
(permite un par de imágenes + un CSV dentro del tope de 5×10 MB). Verificar el
límite actual del back en `back/src/index.js` durante la implementación.

## Límites y constantes

- Máx **5** archivos por mensaje.
- Máx **10 MB** por archivo.
- `accept` (front): mismo set que `Chat.jsx`
  (`image/*,audio/*,video/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.jsx,.tsx,.html,.css`).
- MIME que van al LLM como imagen: `image/jpeg`, `image/png`, `image/gif`,
  `image/webp`, `application/pdf`.
- Carpeta de materialización: `/workspace/.attachments/`.
- Límite de body `express.json`: ~25 MB (back y pod).

## Testing (TDD)

- **session-agent** (foco de cobertura automatizada):
  - `attachments.js`: decode base64, saneo de nombre, bloqueo de path traversal,
    resolución de colisiones.
  - `runAgent`: arma el `content` multimodal correcto según el MIME (imagen →
    `image_url`; texto → solo nota con ruta).
- **back**: `handleWorkspaceStream` reenvía `attachments` al pod.
- **front**: verificación manual del flujo (selección, chips, envío, render en
  el historial).

## Fuera de alcance

- Adjuntos en el chat normal (`Chat.jsx`): ya existen, no se tocan.
- `.gitignore` selectivo o marcado manual asset/referencia (se eligió "todo queda
  en el repo").
- Persistencia de adjuntos entre mensajes distintos: cada adjunto pertenece al
  mensaje con el que se envía (una vez materializado en `.attachments/`, queda en
  el filesystem del pod para esa sesión).
