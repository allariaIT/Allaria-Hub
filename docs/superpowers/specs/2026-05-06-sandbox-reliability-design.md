# Sandbox Reliability & Bug Fixes — Design Spec
**Date:** 2026-05-06
**Status:** Approved

## Overview

Fix all critical, serious, and moderate bugs found in the sandbox/hub de proyectos flow. Central architectural change: make `sandbox_build` (rebuild) fully async following the same pattern already used for project creation, eliminating the synchronous HTTP build that blocks the SSE stream.

---

## 1. Build Async Unificado (Core Change)

### Problem
`POST /projects/:user/:name/build` in sandbox-agent is fully synchronous — it runs Docker build + waitForContainer inline, blocking for 2-3 minutes. `sandboxRequest()` has no timeout. If nginx times out the connection, the backend throws, and project status becomes inconsistent. The SSE stream cannot send responses while the build is in progress.

### Design

**sandbox-agent** — `POST /projects/:user/:name/build` becomes async:
- Responds immediately with `{ ok: true, status: 'building' }` after acquiring the build slot and starting background work
- Background: acquires semaphore, builds image, runs container, waitForContainer, updates `.sandbox-meta.json` to `running` or `error`, releases semaphore

**back/src/lib/sandbox-client.js** — `sandboxBuild()` keeps calling the same endpoint but the endpoint now returns fast.

**back/src/lib/sandbox-tools.js** — `case 'sandbox_build'`:
- Calls `sandboxBuild()` (fast response)
- Polling loop: `sandboxStatus()` every 6s, up to 20 attempts (same pattern as project creation in `routes/projects.js`)
- Updates DB to `running` on success, `error` on failure or timeout
- Returns `{ ok, status, previewUrl }` to LLM

**Timeout on sandboxRequest:**
- Build operations: `AbortSignal.timeout(10_000)` (just for the HTTP call to trigger the build — it's async now)
- Fast operations (read/write/status/push): `AbortSignal.timeout(10_000)`
- The long wait is now in the polling loop, not in a single HTTP call

---

## 2. sandbox-agent Fixes

### 2a. Race Condition en Puertos

**File:** `sandbox-agent/src/lib/docker.js`

Add a module-level `Set` called `reservedPorts`. When `findFreePort` is called, skip ports in either Docker's used set OR `reservedPorts`. Add the chosen port to `reservedPorts` immediately. Remove from `reservedPorts` when the build completes (success or failure) — at that point Docker owns the port.

```js
const reservedPorts = new Set()

export function findFreePort(usedPorts, rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (!usedPorts.has(port) && !reservedPorts.has(port)) {
      reservedPorts.add(port)
      return port
    }
  }
  throw new Error('No hay puertos disponibles en el rango')
}

export function releaseReservedPort(port) {
  reservedPorts.delete(port)
}
```

Call `releaseReservedPort(port)` in the build background async after `runContainer` succeeds (Docker now owns the port binding).

### 2b. Dangling Docker Images

**File:** `sandbox-agent/src/lib/docker.js` — `runContainer()`

Before creating the new container, attempt to remove the old image:
```js
try {
  await docker.getImage(imageTag).remove({ force: true })
} catch {}
```
This runs after stopping/removing the old container, before `docker.createContainer`.

### 2c. git.js — Timeout + Inyección de Comandos

**File:** `sandbox-agent/src/lib/git.js`

- Replace `execSync` string interpolation for commit message with `spawnSync` using argument array — eliminates shell injection vector:
  ```js
  import { spawnSync } from 'node:child_process'
  spawnSync('git', ['commit', '-m', message], { cwd, timeout: 30000 })
  ```
- Add `timeout: 30000` to all git operations to prevent hanging.
- Keep `execSync` for simple commands with no user input (git init, git add, git push), but add timeout.

### 2d. execInContainer — Docker Stream Demultiplex

**File:** `sandbox-agent/src/lib/docker.js` — `execInContainer()`

Docker multiplexes stdout/stderr with an 8-byte header per frame. Strip it:
```js
stream.on('data', (chunk) => {
  // Docker multiplex header: 8 bytes (type 1B, reserved 3B, size 4B)
  let offset = 0
  while (offset < chunk.length) {
    if (chunk.length < offset + 8) break
    const size = chunk.readUInt32BE(offset + 4)
    output += chunk.slice(offset + 8, offset + 8 + size).toString()
    offset += 8 + size
  }
})
```

### 2e. package-lock.json — Builds Determinísticos

**File:** `sandbox-agent/src/lib/scaffold.js` — `Dockerfile`

Change build stage to generate lockfile first, then use `npm ci`:
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --package-lock-only
COPY . .
RUN npm ci
RUN npm run build
```
This generates a lockfile deterministically in the build container and uses `npm ci` for reproducible installs.

---

## 3. back/ Fixes

### 3a. sandbox_create_project vía LLM — Polling + Rollback

**File:** `back/src/lib/sandbox-tools.js` — `case 'sandbox_create_project'`

Current code marks `status: 'running'` immediately. New flow:
1. Create GitLab repo
2. Create DB record with `status: 'creating'`
3. Call `sandboxCreateProject()` — if this throws, rollback: delete DB record + delete GitLab repo, rethrow
4. Update DB with `port`, `previewUrl`, `chatId`, keep `status: 'creating'`
5. Polling loop (same as `routes/projects.js`): every 6s, up to 20 attempts, call `sandboxStatus()`
6. On success: update DB to `status: 'running'`
7. On failure/timeout: update DB to `status: 'error'`
8. Return result to LLM including final status

### 3b. sandbox_build — Async con Polling

**File:** `back/src/lib/sandbox-tools.js` — `case 'sandbox_build'`

```js
case 'sandbox_build': {
  const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
  if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)

  await sandboxBuild(userSlug, args.projectName)  // returns immediately now

  // Poll for completion
  const userSlugForProject = userSlugFromEmail(user.email)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000))
    const status = await sandboxStatus(userSlugForProject, args.projectName)
    if (status.status === 'running') {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
      return { ok: true, message: 'Build completado. Preview actualizada.', previewUrl: project.previewUrl }
    }
    if (status.status === 'error') {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
      return { ok: false, message: 'El build falló. Revisá los archivos.' }
    }
  }
  await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
  return { ok: false, message: 'Timeout esperando el build.' }
}
```

### 3c. Timeout en sandboxRequest

**File:** `back/src/lib/sandbox-client.js`

Add timeout parameter with defaults:
```js
async function sandboxRequest(path, options = {}, timeoutMs = 10_000) {
  const res = await fetch(`${SANDBOX_AGENT_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ... },
  })
}
```
All exported functions use default 10s. No function needs a longer timeout since builds are now async.

### 3d. MAX_TOOL_ROUNDS — Subir a 10

**File:** `back/src/routes/proxy.js`

```js
const MAX_TOOL_ROUNDS = 10
```

### 3e. sandbox_create_project no disponible en workspace

**File:** `front/src/pages/ProjectWorkspace.jsx` — `CONNECTORS`

The workspace already hardcodes `const CONNECTORS = ['sandbox']`. The tool filtering is done server-side in `getToolsForConnectors()`.

**File:** `back/src/lib/tools.js` — add a `workspaceSandbox` connector that excludes `sandbox_create_project`:
```js
// New connector type: sandbox tools minus create
const WORKSPACE_SANDBOX_TOOLS = SANDBOX_TOOL_DEFINITIONS.filter(
  t => t.function.name !== 'sandbox_create_project'
)
```

**File:** `front/src/pages/ProjectWorkspace.jsx`:
```js
const CONNECTORS = ['workspaceSandbox']  // instead of 'sandbox'
```

Also add to `SANDBOX_SYSTEM_PROMPT`: a rule that explicitly says not to create new projects.

### 3f. Reconciliation Job — Detectar containers eliminados

**File:** `back/src/index.js` — `reconcileProjects()`

Add a second pass: find projects with `status: 'running'` in DB, check their container status via `sandboxStatus()`, and if the sandbox returns `stopped` or 404, update DB to `'stopped'`.

```js
// Second pass: running in DB but stopped in reality
const running = await prisma.project.findMany({
  where: { status: 'running', port: { not: null } },
  include: { user: { select: { email: true } } },
})
for (const project of running) {
  try {
    const userSlug = slugFromEmail(project.user.email)
    const status = await sandboxStatus(userSlug, project.name)
    if (status.status !== 'running') {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } })
    }
  } catch {
    // 404 from sandbox = container gone
    await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } }).catch(() => {})
  }
}
```

---

## 4. Frontend Fixes

### 4a. ProjectWorkspace — Auto-refresh cuando status='creating'

**File:** `front/src/pages/ProjectWorkspace.jsx`

When the loaded project has `status === 'creating'`, instead of showing a dead screen, show the creating screen WITH an active polling effect:
```js
useEffect(() => {
  if (project?.status !== 'creating') return
  const interval = setInterval(async () => {
    try {
      const updated = await api.getProject(id)
      if (updated.status !== 'creating') {
        setProject(updated)
        clearInterval(interval)
      }
    } catch {}
  }, 5000)
  return () => clearInterval(interval)
}, [project?.status, id])
```
When it transitions to `'running'`, the workspace renders normally without requiring navigation.

### 4b. Polling "interrumpido" con timeout máximo

**File:** `front/src/pages/ProjectWorkspace.jsx`

Add attempt counter to the interrupted polling:
```js
let attempts = 0
const interval = setInterval(async () => {
  attempts++
  if (attempts > 40) {  // 40 × 3s = 2 minutes
    setInterrupted(false)
    clearInterval(interval)
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: 'No se recibió respuesta. Intentá enviar el mensaje de nuevo.',
    }])
    return
  }
  // ... existing logic
}, 3000)
```

### 4c. handleRetry — Guard sending

**File:** `front/src/pages/ProjectWorkspace.jsx`

```js
const handleRetry = () => {
  if (sending) return  // add this guard
  // ... existing logic
}
```

---

## 5. Files Changed Summary

| File | Changes |
|------|---------|
| `sandbox-agent/src/routes/projects.js` | `POST /build` → async, release reserved port after build |
| `sandbox-agent/src/lib/docker.js` | Reserved ports set, remove dangling image, demultiplex execInContainer |
| `sandbox-agent/src/lib/git.js` | spawnSync with arg array for commit message, timeouts on all ops |
| `sandbox-agent/src/lib/scaffold.js` | Dockerfile: npm install --package-lock-only + npm ci |
| `back/src/lib/sandbox-tools.js` | sandbox_create_project: polling + rollback; sandbox_build: async polling; error status on failure |
| `back/src/lib/sandbox-client.js` | AbortSignal.timeout(10_000) on all requests |
| `back/src/lib/tools.js` | New `workspaceSandbox` connector without create_project |
| `back/src/routes/proxy.js` | MAX_TOOL_ROUNDS = 10 |
| `back/src/index.js` | reconcileProjects: second pass for running→stopped |
| `front/src/pages/ProjectWorkspace.jsx` | Auto-refresh on creating, interrupted timeout, handleRetry guard, CONNECTORS='workspaceSandbox' |

---

## 6. Testing Checklist

- [ ] Crear proyecto via modal → status evoluciona creating → running en UI sin recargar
- [ ] Crear proyecto via LLM chat → mismo comportamiento
- [ ] Modificar archivos + build via LLM → SSE no muere, LLM recibe resultado del build
- [ ] Build falla (archivo con error de sintaxis) → status='error' en DB, LLM reporta el error
- [ ] Dos proyectos creados simultaneamente → no comparten puerto
- [ ] Eliminar container manualmente en sandbox server → reconciliation actualiza a 'stopped'
- [ ] Navegar al workspace de proyecto en 'creating' → auto-refresh al terminar
- [ ] Mensaje en background interrumpido → timeout a los 2 min con mensaje de error
- [ ] Commit message con caracteres especiales → no hay inyección de shell
- [ ] Múltiples rebuilds seguidos → no hay dangling images acumuladas
- [ ] Tarea con 6+ archivos + build → LLM completa con MAX_TOOL_ROUNDS=10
