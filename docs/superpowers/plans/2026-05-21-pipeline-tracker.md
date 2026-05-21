# Pipeline Tracker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar al usuario el progreso del pipeline CI/CD en tiempo real dentro del chat del workspace, con tres estados (corriendo / éxito / error) y lenguaje amigable sin jerga técnica.

**Architecture:** El backend extiende `pollGitlabPipeline` para emitir eventos de etapa via callback; `proxy.js` los inyecta en el buffer SSE del chat; el frontend reconstruye un componente `PipelineTracker` a partir de esos eventos, persistiendo el estado en reconexiones gracias al buffer existente de `active-streams.js`.

**Tech Stack:** Node.js/Express (backend), React 19 + Vite (frontend), SSE (eventos), GitLab Jobs API, active-streams buffer (ya existente).

---

## Archivos

| Archivo | Cambio |
|---|---|
| `back/src/lib/sandbox-tools.js` | `pollGitlabPipeline` acepta `onStage` callback, consulta jobs API, retorna `duration` y `failedJob` |
| `back/src/routes/proxy.js` | Evento `pushed` emite `pipeline_stage/done/error`; SSE se mantiene abierto hasta que el pipeline termine |
| `front/src/pages/ProjectWorkspace.jsx` | `consumeSSE` no rompe en `done`; nuevo estado `pipelineState`; handlers SSE; componente `PipelineTracker` |
| `front/src/pages/ProjectWorkspace.css` | Estilos del `PipelineTracker` |

---

## Task 1: Upgrade `pollGitlabPipeline` en `sandbox-tools.js`

**Files:**
- Modify: `back/src/lib/sandbox-tools.js:13-43`

- [ ] **Step 1: Reemplazar la función `pollGitlabPipeline`**

Ubicar la función en `back/src/lib/sandbox-tools.js` línea 13. Reemplazarla completa por esta versión que acepta un objeto de opciones con `onStage` callback, consulta el endpoint de jobs de GitLab para saber qué etapa está corriendo, y retorna `duration` + `failedJob`:

```js
function fmtDuration(start, end) {
  if (!start || !end) return null
  const secs = Math.round((new Date(end) - new Date(start)) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export async function pollGitlabPipeline(gitlabId, afterTime, { onStage, maxAttempts = 40, delayMs = 15000 } = {}) {
  await new Promise(r => setTimeout(r, 8000))
  let pipelineId = null
  const jobStates = {} // { jobName: lastKnownStatus } — evita emitir duplicados

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines?per_page=5&order_by=id&sort=desc`,
        { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
      )
      const pipelines = await res.json()

      if (!pipelineId) {
        const recent = pipelines.find(p => new Date(p.created_at) >= afterTime)
        if (recent) pipelineId = recent.id
      }

      if (pipelineId) {
        const p = pipelines.find(p => p.id === pipelineId)

        // Consultar jobs para saber qué etapa está corriendo
        if (onStage) {
          try {
            const jobsRes = await fetch(
              `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
              { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
            )
            const jobs = await jobsRes.json()
            for (const job of jobs) {
              if (['running', 'success', 'failed'].includes(job.status) && jobStates[job.name] !== job.status) {
                jobStates[job.name] = job.status
                onStage(job.name, job.status)
              }
            }
          } catch {}
        }

        if (p) {
          if (p.status === 'success') {
            // Calcular duraciones desde started_at/finished_at de cada job
            let duration = {}
            try {
              const jobsRes = await fetch(
                `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
                { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
              )
              const jobs = await jobsRes.json()
              const build = jobs.find(j => j.name === 'docker:build')
              const deploy = jobs.find(j => j.name === 'deploy:server')
              if (build) duration.build = fmtDuration(build.started_at, build.finished_at)
              if (deploy) duration.deploy = fmtDuration(deploy.started_at, deploy.finished_at)
            } catch {}
            return { ok: true, duration }
          }
          if (p.status === 'failed' || p.status === 'canceled') {
            // Encontrar el job que falló
            let failedJob = null
            try {
              const jobsRes = await fetch(
                `${GITLAB_URL}/api/v4/projects/${gitlabId}/pipelines/${pipelineId}/jobs`,
                { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) }
              )
              const jobs = await jobsRes.json()
              const failed = jobs.find(j => j.status === 'failed')
              if (failed) failedJob = failed.name
            } catch {}
            return { ok: false, failedJob, message: `Pipeline CI ${p.status}` }
          }
        }
      }
    } catch {}

    await new Promise(r => setTimeout(r, delayMs))
  }

  return { ok: false, failedJob: null, message: 'Timeout esperando pipeline CI (10 min). Revisá GitLab.' }
}
```

- [ ] **Step 2: Verificar que las llamadas existentes siguen funcionando**

Las llamadas en `sandbox-tools.js` líneas ~233 y ~290 usan `pollGitlabPipeline(gitlabId, time)` con dos argumentos posicionales. El tercer argumento ahora es `options = {}` (objeto opcional), por lo que estas llamadas siguen funcionando sin cambios.

Confirmar visualmente que estas dos llamadas no tienen tercer argumento:
```
const ciResult = await pollGitlabPipeline(gitlabId, createStart)
const ciResult = await pollGitlabPipeline(project.gitlabId, pushStart)
```

Ninguna necesita modificación.

- [ ] **Step 3: Commit**

```bash
git add back/src/lib/sandbox-tools.js
git commit -m "feat(pipeline): pollGitlabPipeline emite etapas via onStage y retorna duration/failedJob"
```

---

## Task 2: Wiring en `proxy.js` — mantener SSE abierto durante el pipeline

**Files:**
- Modify: `back/src/routes/proxy.js:412-430`

**Contexto clave:**
- `send(event)` llama a `rawSend` + `pushEvent(chatId, event)` → entrega al cliente activo Y bufferea para reconexiones
- El bloque `if (data.type === 'pushed')` está dentro del `while (true)` que lee el SSE del pod
- Después del while, hay un `if (assistantContent) await prisma.message.create(...)` y luego `finally { endStream(chatId) }`
- Actualmente `pollGitlabPipeline` corre en background con `.then()` — lo cambiamos a `await` después del while

- [ ] **Step 1: Declarar `pipelinePromise` antes del while loop**

En `handleWorkspaceStream`, justo antes de la línea `while (true) {` (alrededor de línea 399), agregar:

```js
let pipelinePromise = null
```

- [ ] **Step 2: Reemplazar el handler del evento `pushed`**

Localizar el bloque `if (data.type === 'pushed') {` (líneas 412-430) y reemplazarlo completo:

```js
if (data.type === 'pushed') {
  // Re-deploy: el container viejo sigue corriendo. No tocar el status del proyecto.
  // Iniciamos el tracker del pipeline — los eventos van al buffer SSE del chat
  // para que persistan si el usuario se reconecta.
  const project = await prisma.project.findFirst({ where: { id: projectId } })
  if (project?.gitlabId) {
    const pushTime = new Date()
    pipelinePromise = pollGitlabPipeline(project.gitlabId, pushTime, {
      onStage: (job, status) => send({ type: 'pipeline_stage', job, status }),
    }).then(async (result) => {
      if (result.ok) {
        send({ type: 'pipeline_done', duration: result.duration || {} })
      } else {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        send({ type: 'pipeline_error', failedJob: result.failedJob || null, message: result.message })
      }
    }).catch(() => {})
  }
}
```

- [ ] **Step 3: Await `pipelinePromise` antes de cerrar el stream**

Después del `while (true)` loop y después del bloque `if (assistantContent)` que guarda en DB (alrededor de línea 435-440), agregar:

```js
// Esperar a que termine el pipeline antes de cerrar el stream SSE.
// Así los eventos pipeline_stage/done/error llegan al cliente en vivo
// y quedan en el buffer para reconexiones.
if (pipelinePromise) await pipelinePromise
```

El bloque queda así:
```js
// ... while(true) loop termina ...

if (assistantContent) {
  await prisma.message.create({
    data: { chatId, role: 'assistant', content: assistantContent, model: 'claude-sonnet-4-5' },
  })
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
}

// Nuevo: esperar pipeline antes de cerrar el stream
if (pipelinePromise) await pipelinePromise

} catch (err) {
  // ...
} finally {
  endStream(chatId, streamFinalStatus)
}
```

- [ ] **Step 4: Commit**

```bash
git add back/src/routes/proxy.js
git commit -m "feat(pipeline): emitir eventos pipeline_stage/done/error via SSE durante re-deploy"
```

---

## Task 3: `consumeSSE` — no cortar en `done`, esperar `_stream_ended`

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.jsx` — función `consumeSSE`

**Por qué:** Actualmente `consumeSSE` rompe el loop cuando recibe `done`, ignorando todo lo que venga después. Ahora el backend sigue enviando `pipeline_stage/done/error` después del `done` del LLM, hasta que manda `_stream_ended`. El frontend tiene que seguir leyendo.

- [ ] **Step 1: Localizar la línea que rompe en `done`**

En `consumeSSE` (alrededor de línea 279 en `ProjectWorkspace.jsx`), encontrar:

```js
if (event.type === 'done' || event.type === 'error') ended = true
```

- [ ] **Step 2: Quitar el break en `done`**

Reemplazar esa línea por:

```js
if (event.type === 'error') ended = true
// No romper en 'done': el backend puede seguir enviando pipeline_stage/done/error
// hasta que mande _stream_ended, que cierra el stream definitivamente.
```

- [ ] **Step 3: Verificar el comportamiento para streams sin pipeline**

Para chats sin push (preguntas normales), el backend llama `endStream()` justo después del `done`, lo que envía `_stream_ended` inmediatamente. El frontend lo recibe y termina igual que antes. No hay cambio en el comportamiento normal.

- [ ] **Step 4: Commit**

```bash
git add front/src/pages/ProjectWorkspace.jsx
git commit -m "fix(workspace): mantener SSE abierto hasta _stream_ended para recibir eventos de pipeline"
```

---

## Task 4: Estado `pipelineState` y handlers SSE en `ProjectWorkspace.jsx`

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.jsx`

- [ ] **Step 1: Agregar la constante `PIPELINE_STAGES` y el estado `pipelineState`**

Agregar la constante después de `const DEFAULT_MODEL` y `const CONNECTORS` (alrededor de línea 37):

```js
const PIPELINE_STAGES = [
  { id: 'docker:build', emoji: '📦', label: 'Empaquetando tu app', durationKey: 'build' },
  { id: 'deploy:server', emoji: '🚀', label: 'Lanzando al servidor', durationKey: 'deploy' },
  { id: 'live', emoji: '🎉', label: '¡Tu app lista!', durationKey: null },
]
```

Agregar el estado en el bloque de `useState` dentro de `ProjectWorkspace` (después de `const [copied, setCopied]`):

```js
const [pipelineState, setPipelineState] = useState(null)
// null = sin pipeline activo/reciente
// { status: 'running'|'success'|'error', stages: [{id, status}], duration: {}, failedJob: null|string }
```

- [ ] **Step 2: Reemplazar el handler de `pushed` en `handleStreamEvent`**

Localizar el bloque actual:
```js
if (event.type === 'pushed') {
  setActivitySync(prev => ({
    ...prev,
    events: [...prev.events, {
      id: `push-${Date.now()}`,
      type: 'info',
      label: 'CI de GitLab desplegando...',
    }],
  }))
  return
}
```

Reemplazar por:
```js
if (event.type === 'pushed') {
  setPipelineState({
    status: 'running',
    stages: PIPELINE_STAGES.map(s => ({ id: s.id, status: 'pending' })),
    duration: {},
    failedJob: null,
  })
  return
}
```

- [ ] **Step 3: Agregar los tres handlers nuevos en `handleStreamEvent`**

Agregar DESPUÉS del handler de `pushed` (y ANTES del handler de `done`):

```js
if (event.type === 'pipeline_stage') {
  setPipelineState(prev => {
    if (!prev) return prev
    const statusMap = { running: 'running', success: 'done', failed: 'failed' }
    return {
      ...prev,
      stages: prev.stages.map(s =>
        s.id === event.job ? { ...s, status: statusMap[event.status] ?? event.status } : s
      ),
    }
  })
  return
}

if (event.type === 'pipeline_done') {
  setPipelineState(prev => prev ? {
    ...prev,
    status: 'success',
    stages: prev.stages.map(s => ({ ...s, status: 'done' })),
    duration: event.duration || {},
  } : prev)
  return
}

if (event.type === 'pipeline_error') {
  setPipelineState(prev => {
    if (!prev) return prev
    return {
      ...prev,
      status: 'error',
      failedJob: event.failedJob || null,
      stages: prev.stages.map(s =>
        s.id === event.failedJob ? { ...s, status: 'failed' } : s
      ),
    }
  })
  return
}
```

- [ ] **Step 4: Resetear `pipelineState` al enviar un mensaje nuevo**

En `doSend`, después de `setActivitySync(emptyActivity())`, agregar:

```js
setPipelineState(null)
```

- [ ] **Step 5: Actualizar el placeholder y disabled del textarea**

Localizar el `<textarea>` en el render (alrededor de línea 625). Actualizar el `placeholder`:

```jsx
placeholder={
  pipelineState?.status === 'running'
    ? '🔒 Tu app se está publicando, el chat se activa cuando esté lista...'
    : 'Pedile a la IA que cree archivos, modifique código, buildee...'
}
```

El `disabled={sending}` ya bloquea durante el pipeline (el stream sigue abierto mientras el pipeline corre), no necesita cambio.

- [ ] **Step 6: Renderizar `PipelineTracker` en la lista de mensajes**

Localizar `<div ref={messagesEndRef} />` al final del bloque `pw-messages`. Agregar ANTES de esa línea:

```jsx
{pipelineState && (
  <PipelineTracker
    pipelineState={pipelineState}
    previewUrl={project?.previewUrl}
    onRetry={() => doSend('Por favor reintentá el deploy')}
  />
)}
```

- [ ] **Step 7: Commit**

```bash
git add front/src/pages/ProjectWorkspace.jsx
git commit -m "feat(pipeline): estado pipelineState y handlers SSE para tracker en el chat"
```

---

## Task 5: Componente `PipelineTracker`

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.jsx` — agregar función al final del archivo (como `ActivityCard`)

- [ ] **Step 1: Agregar el componente al final de `ProjectWorkspace.jsx`**

Después del cierre de la función `ActivityCard`, agregar:

```jsx
function PipelineTracker({ pipelineState, previewUrl, onRetry }) {
  const { status, stages, duration, failedJob } = pipelineState

  const header = {
    running: 'Tu cambio está viajando…',
    success: '¡Cambio publicado!',
    error: 'Algo salió mal',
  }[status]

  const hint = {
    running: '🔒 El chat se activa cuando tu app esté lista',
    success: '✅ ¡Listo! Podés seguir haciendo cambios',
    error: '⚠️ Chat desbloqueado — podés pedirme que reintente',
  }[status]

  return (
    <div className={`pw-pipeline pw-pipeline--${status}`}>
      <div className="pw-pipeline-header">
        <span className={`pw-pipeline-dot pw-pipeline-dot--${status}`} />
        <span>{header}</span>
      </div>

      {status === 'success' && (
        <div className="pw-pipeline-celebration">
          <span className="pw-pipeline-glow">🎉</span>
          <div>
            <div className="pw-pipeline-celebration-title">¡Tu app está en vivo!</div>
            <div className="pw-pipeline-celebration-sub">Los cambios ya son visibles para todos</div>
          </div>
        </div>
      )}

      {PIPELINE_STAGES.map(def => {
        const stage = stages.find(s => s.id === def.id) || { id: def.id, status: 'pending' }
        const dur = def.durationKey ? duration[def.durationKey] : null

        const sub = {
          pending: 'Pronto…',
          running: 'En camino…',
          done: dur || 'Completado',
          failed: 'No pudo completarse',
        }[stage.status] ?? ''

        return (
          <div key={def.id} className={`pw-pipeline-step pw-pipeline-step--${stage.status}`}>
            <div className={`pw-pipeline-icon${stage.status === 'running' ? ' pw-pipeline-icon--anim' : ''}`}>
              {def.emoji}
            </div>
            <div className="pw-pipeline-step-info">
              <div className="pw-pipeline-step-name">{def.label}</div>
              <div className="pw-pipeline-step-sub">{sub}</div>
            </div>
            {stage.status === 'done' && <span className="pw-pipeline-check">✓</span>}
            {stage.status === 'running' && <div className="pw-pipeline-spin" />}
            {stage.status === 'failed' && <span className="pw-pipeline-x">✗</span>}
          </div>
        )
      })}

      {status === 'success' && previewUrl && (
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="pw-pipeline-preview-btn">
          🌐 Ver mi app →
        </a>
      )}

      {status === 'error' && (
        <p className="pw-pipeline-error-msg">
          La app anterior sigue funcionando mientras resolvemos esto.
        </p>
      )}

      {status === 'error' && (
        <button className="pw-pipeline-retry-btn" onClick={onRetry}>
          🔁 Pedirle a la IA que reintente
        </button>
      )}

      <div className={`pw-pipeline-hint pw-pipeline-hint--${status}`}>{hint}</div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add front/src/pages/ProjectWorkspace.jsx
git commit -m "feat(pipeline): componente PipelineTracker con estados running/success/error"
```

---

## Task 6: CSS del `PipelineTracker`

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.css`

- [ ] **Step 1: Agregar los estilos al final de `ProjectWorkspace.css`**

```css
/* ─────────────────────────────────────────────────────────────────────────
   PipelineTracker — card en el chat que muestra progreso de CI/deploy
   ───────────────────────────────────────────────────────────────────────── */
.pw-pipeline {
  margin-left: 38px;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border-light);
  position: relative;
}

.pw-pipeline--running {
  background: #111827;
  border-left: 3px solid #6366f1;
  border-color: #1e3a5f;
}

.pw-pipeline--success {
  background: #0a1f12;
  border-left: 3px solid #22c55e;
  border-color: #166534;
}

.pw-pipeline--error {
  background: #1a0f0f;
  border-left: 3px solid #ef4444;
  border-color: #7f1d1d;
}

/* Header */
.pw-pipeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border-light);
}

.pw-pipeline--running .pw-pipeline-header { color: #818cf8; }
.pw-pipeline--success .pw-pipeline-header { color: #4ade80; }
.pw-pipeline--error   .pw-pipeline-header { color: #f87171; }

.pw-pipeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pw-pipeline-dot--running {
  background: #6366f1;
  animation: pw-pulse 1.4s ease-out infinite;
}

.pw-pipeline-dot--success { background: #22c55e; }
.pw-pipeline-dot--error   { background: #ef4444; }

/* Celebración (estado success) */
.pw-pipeline-celebration {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.pw-pipeline-glow {
  font-size: 28px;
  filter: drop-shadow(0 0 10px rgba(34, 197, 94, .5));
  animation: pop .4s ease;
}

.pw-pipeline-celebration-title {
  font-size: 13px;
  font-weight: 800;
  color: #4ade80;
}

.pw-pipeline-celebration-sub {
  font-size: 11px;
  color: #86efac;
  margin-top: 2px;
}

/* Steps */
.pw-pipeline-step {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pw-pipeline-step--pending { opacity: .35; }

.pw-pipeline-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
}

.pw-pipeline-step--done   .pw-pipeline-icon { background: rgba(34,  197, 94,  .15); }
.pw-pipeline-step--running .pw-pipeline-icon { background: rgba(99,  102, 241, .2);  }
.pw-pipeline-step--failed .pw-pipeline-icon { background: rgba(239, 68,  68,  .15); }
.pw-pipeline-step--pending .pw-pipeline-icon { background: var(--bg-tertiary); }

.pw-pipeline-icon--anim { animation: wobble 1.5s ease-in-out infinite; }

.pw-pipeline-step-info { flex: 1; }

.pw-pipeline-step-name {
  font-size: 11px;
  font-weight: 700;
}

.pw-pipeline-step-sub {
  font-size: 10px;
  margin-top: 1px;
}

.pw-pipeline-step--done   .pw-pipeline-step-name { color: #86efac; }
.pw-pipeline-step--done   .pw-pipeline-step-sub  { color: #4ade80; }
.pw-pipeline-step--running .pw-pipeline-step-name { color: #a5b4fc; }
.pw-pipeline-step--running .pw-pipeline-step-sub  { color: #6366f1; }
.pw-pipeline-step--failed .pw-pipeline-step-name { color: #fca5a5; }
.pw-pipeline-step--failed .pw-pipeline-step-sub  { color: #ef4444; }
.pw-pipeline-step--pending .pw-pipeline-step-name { color: #334155; }
.pw-pipeline-step--pending .pw-pipeline-step-sub  { color: #1e293b; }

.pw-pipeline-check {
  font-size: 12px;
  font-weight: 800;
  color: #22c55e;
  flex-shrink: 0;
}

.pw-pipeline-x {
  font-size: 12px;
  font-weight: 800;
  color: #ef4444;
  flex-shrink: 0;
}

.pw-pipeline-spin {
  width: 13px;
  height: 13px;
  border: 2px solid #334155;
  border-top-color: #818cf8;
  border-radius: 50%;
  animation: pw-spin .8s linear infinite;
  flex-shrink: 0;
}

/* Botón "Ver mi app" */
.pw-pipeline-preview-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 800;
  background: linear-gradient(135deg, #16a34a, #22c55e);
  color: white;
  text-decoration: none;
  box-shadow: 0 4px 12px rgba(34, 197, 94, .25);
  transition: opacity var(--transition-fast);
  margin-top: 2px;
}

.pw-pipeline-preview-btn:hover { opacity: .88; }

/* Mensaje de error */
.pw-pipeline-error-msg {
  font-size: 11px;
  color: #fca5a5;
  line-height: 1.45;
  padding: 6px 0;
}

/* Botón "Reintentar" */
.pw-pipeline-retry-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(239, 68, 68, .12);
  border: 1px solid rgba(239, 68, 68, .3);
  color: #f87171;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.pw-pipeline-retry-btn:hover {
  background: rgba(239, 68, 68, .2);
}

/* Hint de estado del input */
.pw-pipeline-hint {
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11px;
  margin-top: 2px;
}

.pw-pipeline-hint--running {
  background: rgba(99, 102, 241, .07);
  border: 1px dashed rgba(99, 102, 241, .25);
  color: #475569;
}

.pw-pipeline-hint--success {
  background: rgba(34, 197, 94, .07);
  border: 1px solid rgba(34, 197, 94, .2);
  color: #4ade80;
  font-weight: 600;
}

.pw-pipeline-hint--error {
  background: rgba(234, 179, 8, .07);
  border: 1px solid rgba(234, 179, 8, .2);
  color: #eab308;
}

/* Keyframes */
@keyframes pw-pulse {
  0%   { box-shadow: 0 0 0 0   rgba(99, 102, 241, .5); }
  70%  { box-shadow: 0 0 0 8px rgba(99, 102, 241, 0);  }
  100% { box-shadow: 0 0 0 0   rgba(99, 102, 241, 0);  }
}

@keyframes pw-spin { to { transform: rotate(360deg); } }

@keyframes wobble {
  0%,  100% { transform: translateY(0)    rotate(-4deg); }
  50%       { transform: translateY(-5px) rotate(4deg);  }
}

@keyframes pop {
  0%  { transform: scale(.5); opacity: 0; }
  80% { transform: scale(1.15); }
  100%{ transform: scale(1);   opacity: 1; }
}

@media (max-width: 768px) {
  .pw-pipeline { margin-left: 0; max-width: 100%; }
}
```

- [ ] **Step 2: Commit**

```bash
git add front/src/pages/ProjectWorkspace.css
git commit -m "feat(pipeline): estilos PipelineTracker — running, success y error"
```

---

## Task 7: Deploy y verificación manual

**Files:** ninguno — solo comandos

- [ ] **Step 1: Build y push a dev**

```bash
git push origin main
```

El CI buildea el Hub y lo deploya en CCE automáticamente (watch en GitLab CI del repo Allaria-Hub).

- [ ] **Step 2: Verificar estado "En progreso"**

1. Abrir el workspace de un proyecto en el Hub de dev
2. Pedirle al agente: `"Agregá un comentario cualquiera en App.jsx"`
3. El agente ejecuta el flujo: `read_file → write_file → git_push`
4. Después del `git_push`, el tracker debe aparecer en el chat con:
   - Dot pulsante violeta
   - Header "Tu cambio está viajando…"
   - 📦 Empaquetando tu app — pending
   - 🚀 Lanzando al servidor — pending
   - 🎉 ¡Tu app lista! — pending
5. Input del chat bloqueado con placeholder `🔒 Tu app se está publicando...`
6. Al poco tiempo: 📦 cambia a `running`, luego a `done ✓`; 🚀 cambia a `running`

- [ ] **Step 3: Verificar estado "Éxito"**

7. Después de ~2 minutos, el tracker debe mostrar:
   - Header "¡Cambio publicado!"
   - 🎉 emoji con glow verde
   - Todos los pasos en verde con duración (ej: "1m 12s")
   - Botón verde `🌐 Ver mi app →`
   - Hint verde "✅ ¡Listo! Podés seguir haciendo cambios"
   - Input desbloqueado

- [ ] **Step 4: Verificar reconexión**

8. Mientras el pipeline está en progreso (entre step 2 y 3), cerrar la pestaña y volver a abrir el workspace
9. El tracker debe aparecer con el estado actual (no desde cero), reflejo del buffer de active-streams

- [ ] **Step 5: Verificar estado "Error" (si aplica)**

Para forzar un error: editar un archivo del proyecto de forma que el build falle (ej: `package.json` malformado). El tracker debe mostrar:
- El paso que falló con `✗` rojo
- Mensaje "La app anterior sigue funcionando..."
- Botón `🔁 Pedirle a la IA que reintente`
- Al hacer click en el botón, se envía `"Por favor reintentá el deploy"` al chat automáticamente
