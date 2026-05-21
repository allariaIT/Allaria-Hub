# Pipeline Tracker en el Workspace

**Fecha:** 2026-05-21  
**Estado:** Aprobado por usuario

---

## Problema

Cuando el agente hace un push, el CI de GitLab tarda ~2 minutos en buildear y deployar. Hoy el usuario ve solo una línea "CI de GitLab desplegando..." y no tiene forma de saber qué pasa, si terminó, o si falló. El usuario no tiene cuenta de GitLab.

---

## Solución

Un **tracker visual en el chat** — aparece como un "mensaje del bot" después del push, muestra las etapas en tiempo real con lenguaje amigable, bloquea el input mientras corre, y presenta estados de éxito/error claros. Persiste si el usuario sale y vuelve al workspace.

---

## Diseño visual

### Ubicación
Aparece en el chat (opción A elegida), justo después del último mensaje del bot, como si fuera un mensaje especial. No es una tarjeta de actividad genérica — tiene su propio componente `PipelineTracker`.

### Las tres etapas (lenguaje amigable, sin jerga técnica)

| Etapa interna (GitLab job) | Emoji | Label visible |
|---|---|---|
| `docker:build` | 📦 | Empaquetando tu app |
| `deploy:server` | 🚀 | Lanzando al servidor |
| Pipeline `success` completo | 🎉 | ¡Tu app lista! |

### Estado: En progreso
- Header pulsante: "Tu cambio está viajando…"
- Pasos con estado: `done` (verde ✓) / `running` (spinner + emoji animado) / `pending` (gris apagado)
- Input bloqueado: `🔒 El chat se activa cuando esté en vivo`

### Estado: Éxito
- Header: "¡Cambio publicado!"
- Emoji 🎉 grande con glow verde
- Todos los pasos en verde con tiempo de cada etapa
- Botón prominente `🌐 Ver mi app →` (link a `project.previewUrl`)
- Input desbloqueado: `✅ ¡Listo! Podés seguir haciendo cambios`

### Estado: Error
- Header: "Algo salió mal"
- Muestra qué etapa falló (📦 ✓ → 🚀 ✗)
- Mensaje tranquilizador: "La app anterior sigue funcionando mientras resolvemos esto."
- Botón `🔁 Pedirle a la IA que reintente` (pre-llena el input con "Por favor reintentá el deploy")
- Input desbloqueado con aviso amarillo

---

## Arquitectura

### Nuevo flujo de eventos SSE

El back ya tiene `pushEvent(chatId, event)` y `active-streams.js` para buffer/replay. Se agregan tres nuevos tipos de evento:

```
pipeline_stage  →  { type: 'pipeline_stage', job: 'docker:build'|'deploy:server', status: 'running'|'success'|'failed' }
pipeline_done   →  { type: 'pipeline_done', ok: true, duration: { build: '1m 10s', deploy: '38s' } }
pipeline_error  →  { type: 'pipeline_error', failedJob: 'docker:build'|'deploy:server', message: string }
```

### Cambios en `back/src/lib/sandbox-tools.js`

`pollGitlabPipeline` recibe un callback opcional `onStage(job, status)`:

```js
export async function pollGitlabPipeline(gitlabId, afterTime, { onStage, maxAttempts = 40, delayMs = 15000 } = {})
```

En cada iteración, además de chequear el pipeline, consulta los jobs via:
```
GET /api/v4/projects/:gitlabId/pipelines/:pipelineId/jobs
```
y llama `onStage(job.name, job.status)` cuando un job cambia de estado. Internamente trackea el estado anterior para no emitir duplicados.

### Cambios en `back/src/routes/proxy.js`

En el handler del evento `pushed`, se pasan los stage updates al stream del chat:

```js
pollGitlabPipeline(project.gitlabId, new Date(), {
  onStage: (job, status) => pushEvent(chatId, { type: 'pipeline_stage', job, status }),
}).then(result => {
  if (result.ok) {
    pushEvent(chatId, { type: 'pipeline_done', ok: true, duration: result.duration })
  } else {
    pushEvent(chatId, { type: 'pipeline_error', failedJob: result.failedJob, message: result.message })
  }
})
```

El mismo bloque aplica a los re-deploys en proxy.js (después del evento `pushed` del session-agent).

### Cambios en `front/src/pages/ProjectWorkspace.jsx`

**Nuevo estado:**
```js
const [pipelineState, setPipelineState] = useState(null)
// null | { status: 'running'|'success'|'error', stages: [...], duration: {...}, failedJob: string }
```

**Nuevos handlers en `handleStreamEvent`:**
- `pipeline_stage` → actualiza `pipelineState.stages[job].status`
- `pipeline_done` → `pipelineState.status = 'success'`, guarda durations
- `pipeline_error` → `pipelineState.status = 'error'`, guarda failedJob

**Input bloqueado** cuando `pipelineState?.status === 'running'`.

**Render:** el `PipelineTracker` se inserta en el listado de mensajes como último elemento cuando `pipelineState !== null`. No es un mensaje guardado en DB — es UI efímera reconstruida desde los eventos del stream (que persisten via active-streams buffer en memoria).

**Nuevo componente `PipelineTracker`** en `ProjectWorkspace.jsx` (o archivo separado `PipelineTracker.jsx`):
- Recibe `pipelineState` y `previewUrl`
- Renderiza los tres estados
- Botón "reintente": llama `doSend("Por favor reintentá el deploy")`

### Persistencia al reconectar

El mecanismo de replay existente (`GET /api/projects/:id/session/active-stream`) ya bufferiza todos los eventos SSE en memoria por `chatId`. Al reconectar:
- Si el pipeline sigue corriendo: el front recibe todos los eventos anteriores y reconstruye el estado actual del tracker
- Si el pipeline ya terminó: recibe `pipeline_done` o `pipeline_error` y muestra el estado final directamente

No se necesita ningún cambio en la lógica de reconexión.

---

## Archivos a modificar

| Archivo | Cambio |
|---|---|
| `back/src/lib/sandbox-tools.js` | `pollGitlabPipeline` + callback `onStage` + consulta jobs API + retorna `duration` y `failedJob` |
| `back/src/routes/proxy.js` | Pasar `onStage` callback en ambas llamadas a `pollGitlabPipeline`, emitir `pipeline_stage/done/error` |
| `front/src/pages/ProjectWorkspace.jsx` | Estado `pipelineState`, handlers nuevos en `handleStreamEvent`, render `PipelineTracker`, bloqueo del input |
| `front/src/pages/ProjectWorkspace.css` | Estilos del componente `PipelineTracker` |

---

## Lo que NO cambia

- La lógica de active-streams y replay no se toca.
- El estado del proyecto en DB (`status: 'error'`) se sigue seteando igual que hoy en el error.
- El session-agent no cambia.
- Los mensajes no se guardan en DB — el tracker es UI reconstructible desde el buffer de eventos.
