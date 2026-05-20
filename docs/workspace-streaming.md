# Workspace streaming — arquitectura

Esta nota explica cómo fluyen los eventos del workspace de proyectos (`ProjectWorkspace.jsx` ⇄ `proxy.js` ⇄ session pod). Si vas a tocar el flow de chat / activity card / reconexión, leelo antes.

## Flow completo

```
ProjectWorkspace.jsx ── POST /api/chat/stream ──▶ back/proxy.js
                                                       │
                                                       │  handleWorkspaceStream
                                                       │  1. startStream(chatId) en active-streams
                                                       │  2. getOrCreateSession → pod en sandbox-sessions
                                                       │  3. waitForPodReady (hasta 120s)
                                                       │  4. fetch http://{podIP}:3200/chat
                                                       ▼
                                              session-agent (pod CCE)
                                              ── runAgent(message, history) ──▶ LiteLLM
                                              ◀── yields text/tool_start/tool_done/pushed ──
                                                       │
                                                       │  Cada evento del pod se pipea con send()
                                                       │  send() = rawSend (al cliente original)
                                                       │        + pushEvent (al buffer en RAM)
                                                       ▼
                                              ProjectWorkspace.jsx (consumeSSE)
                                              handleStreamEvent dispatch por event.type
```

## Eventos del stream (SSE)

| Tipo | Origen | Significado en UI |
|---|---|---|
| `workspace_starting` | back (handleWorkspaceStream) | Pod arrancando — banner amarillo arriba del chat |
| `workspace_ready` | back | Pod listo — quita el banner |
| `thinking` | session-agent | (ignorado; la activity card ya da el feedback) |
| `text` | session-agent / agent.js | Texto del bot. Se acumula en el último bloque `text` de la activity card |
| `tool_start` | session-agent | Chip running con label de la herramienta (`Leyendo X`, `Escribiendo Y`, `$ npm install`) |
| `tool_done` | session-agent | Marca el último chip running como done (check verde) |
| `pushed` | session-agent + back | El bot hizo git_push. Back **NO** marca proyecto como `creating` (es re-deploy); solo trackea pipeline para marcar `error` si falla |
| `done` | session-agent | Fin del turno. Front cierra la activity card y pinta el **último bloque de texto** como mensaje del bot (no toda la narración, que el usuario ya vio en vivo) |
| `error` | back / session-agent | Mensaje de error como respuesta del bot |
| `_stream_ended` | active-streams | Señal interna para el endpoint de reconexión: el buffer terminó |
| `no_active_stream` | active-streams | No había stream activo para este chat |

## Reconexión (cliente que sale y vuelve)

El back guarda en memoria todos los eventos del flujo en `active-streams.js` (`Map<chatId, {events[], status, subscribers}>`). Cuando el cliente vuelve a entrar:

1. `ProjectWorkspace.jsx` detecta `messages[-1].role === 'user'` (último mensaje sin respuesta del bot)
2. Llama `GET /api/projects/:id/session/active-stream` (SSE)
3. El back hace **replay** del buffer entero + suscribe al `res` para eventos futuros
4. Cuando el stream original termina (`done` o `error`), el back manda `_stream_ended` y cierra el subscriber
5. Si el buffer no existe (>5 min después), back responde `no_active_stream` y el front cae al fetch de chat normal

Caps del buffer:
- 500 eventos por chatId (descarta más viejos)
- Buffer terminado se mantiene 5 min, después se limpia

## State del front (ProjectWorkspace.jsx)

| State | Uso |
|---|---|
| `messages` | Mensajes persistidos (user + assistant final) que se ven en el chat |
| `activity` | `{events: [], status}` — la tarjeta de actividad en vivo. Se vacía al `done` |
| `activityRef` | Ref paralelo a `activity` para lectura síncrona en handlers SSE (React state está stale en updaters async) |
| `workspaceStatus` | `unknown` / `starting` / `ready` / `none` — controla el banner amarillo |
| `sending` | `true` mientras hay un stream activo |

⚠️ **Importante**: usar `setActivitySync()` (no `setActivity` directo) en handlers SSE. Mantiene `activityRef` sincronizado, lo cual es crítico para extraer el "último bloque de texto" al recibir `done` (un bug previo dejaba mensajes sin pintar por race condition entre updater y microtask).

## Backend / handleWorkspaceStream — detalles

- El `send()` original (`rawSend`) escribe SSE al cliente conectado. Si el cliente se desconectó (`clientConnected = false`), ya no escribe — pero **el back sigue procesando** y guarda el mensaje final en DB.
- `pushEvent()` agrega al buffer + reenvía a subscribers. Subscribers son **otros clientes** (reconexiones) que llegaron mientras el flow corría.
- Al final, `endStream(chatId, status)` notifica a subscribers y programa limpieza del buffer.

## Decisiones sutiles que ya pisamos antes

1. **`done.content` vs último bloque de texto**: el back guarda en DB la concatenación completa del bot (`fullText`), pero el front pinta solo el último bloque como veredicto. Sin eso, el usuario ve duplicado el texto que ya leyó en vivo.
2. **Re-deploy NO cambia status del proyecto**: cuando el bot pushea, el container viejo sigue corriendo. Marcar `creating` durante el push sacaba al usuario del workspace con la pantalla genérica de "proyecto recién creado".
3. **Pantalla `creating` solo si chat vacío**: si hay mensajes, asumimos re-deploy y mantenemos al usuario en el workspace aunque status sea `creating` (defensa por si algún código viejo lo setea).
4. **Race de setActivity / setMessages**: al recibir `done`, leer el último bloque de texto desde `activityRef.current` (síncrono), no desde el state dentro de un updater.

## Archivos clave

- `back/src/lib/active-streams.js` — buffer en memoria + pub/sub
- `back/src/routes/proxy.js` — `handleWorkspaceStream` envuelve send con pushEvent
- `back/src/routes/sessions.js` — `GET /active-stream` para reconexión
- `front/src/pages/ProjectWorkspace.jsx` — state, handlers SSE, render de activity card
- `front/src/lib/api.js` — `openActiveStream()`, `getSession()`
- `session-agent/src/agent.js` — yields text/tool_start/tool_done
- `session-agent/src/index.js` — wrapping de yields como SSE
