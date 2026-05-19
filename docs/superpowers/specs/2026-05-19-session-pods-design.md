# Session Pods — Diseño Phase 2

**Fecha:** 2026-05-19  
**Estado:** Aprobado, pendiente de implementación  
**Contexto:** Reemplaza el sandbox-agent monolítico por pods efímeros en CCE con Claude Agent SDK.

---

## Problema

El sandbox-agent actual es un proceso monolítico en `.101` que:
- Mantiene el estado de todos los proyectos en disco
- Corre un solo proceso para todos los usuarios en paralelo
- No escala horizontalmente
- El loop de tool-calling (LiteLLM + tools) vive en el back-end, que orquesta cada paso manualmente

## Solución

Un pod efímero por sesión de workspace. El pod clona el repo del proyecto, corre un agente con Claude vía Anthropic SDK + LiteLLM, y solo hace tres cosas: leer archivos, escribir archivos, pushear a GitLab. El CI existente se encarga del build y deploy.

---

## Arquitectura

```
Usuario tipea mensaje
  → front  POST /api/chat/stream  { chatId, messages, projectId }
  → back   busca o crea Session activa para { userId, projectId }
  → back   POST http://{podClusterIP}:3200/chat  { message, history }
  → pod    loop Anthropic SDK con tools (read/write/list/bash/git_push)
  → pod    streama SSE → back → front (mismo protocolo que hoy)
  → cuando pod emite evento { type: 'pushed' }
    → back dispara pollGitlabPipeline() y streama progreso de CI al front
```

### Responsabilidades

| Componente | Responsabilidad |
|---|---|
| Pod (session agent) | Clonar repo, leer/escribir archivos, bash limitado, git push |
| Back-end | Auth, spawn/kill pods via K8s API, relay SSE, poll CI, DB |
| GitLab CI | Build Docker, push SWR, deploy container en .101 |
| sandbox-nginx | Routing de proyectos (sin cambios) |
| Frontend | Fire-and-forget session start, mismo protocolo SSE |

### Conexión: a través del back-end (proxy)

Los pods corren en ClusterIP — sin IP pública. El back-end autentica al usuario, busca el pod de su sesión, y hace proxy del SSE. Auth centralizada, sin ingress por pod, patrón estándar (JupyterHub, Codespaces).

---

## Pod: session-agent

### Imagen

- Base: `node:23-alpine`
- Contiene: git, openssh-client, Anthropic SDK, Express
- Build y push a SWR: `sandbox-allaria/session-agent:latest`
- Tamaño estimado: ~150MB

### Startup sequence

```
1. git clone {REPO_URL} /workspace      (~5s)
2. cd /workspace && npm install          (~30s)
3. Levanta HTTP server en :3200
4. Status → 'ready'
```

### Variables de entorno del pod

```
REPO_URL        https://oauth2:{GITLAB_TOKEN}@gitlab.allaria.xyz/{path}.git
LITELLM_URL     http://172.30.200.101:4000
LITELLM_KEY     sk-allaria-c72b517ee924cce3a1963264
SESSION_ID      {cuid}
BACK_URL        http://back.allaria-hub.svc.cluster.local:3098
```

### Anthropic SDK con LiteLLM

```js
const anthropic = new Anthropic({
  apiKey: process.env.LITELLM_KEY,
  baseURL: process.env.LITELLM_URL,
})
```

El pod usa `claude-sonnet-4-5` vía LiteLLM. El modelo se puede cambiar desde LiteLLM sin tocar el pod.

### Tools del agente (5)

| Tool | Descripción | Implementación |
|---|---|---|
| `read_file(path)` | Lee un archivo del proyecto | `fs.readFileSync('/workspace/' + path)` |
| `write_file(path, content)` | Escribe o sobreescribe un archivo | `fs.writeFileSync`, crea dirs |
| `list_files()` | Árbol de archivos del proyecto | Walk de `/workspace`, excluye `node_modules/.git/dist` |
| `bash(cmd)` | Ejecuta comando de desarrollo | `spawnSync`, allowlist de comandos |
| `git_push(message)` | Commitea y pushea al repo | `git add -A && git commit -m && git push`, emite evento `pushed` |

#### Allowlist de bash

Permitidos: `npm install`, `npm run`, `npm ci`, `npx`, `node`, `cat`, `ls`, `mkdir`, `cp`, `mv`  
Bloqueados: `rm -rf /`, `curl`, `wget`, `ssh`, `sudo`, cualquier acceso a red

### System prompt del agente

El `SANDBOX_SYSTEM_PROMPT` existente en `ProjectWorkspace.jsx` debe actualizarse: los nombres de tools cambian (`sandbox_write_file` → `write_file`, `sandbox_read_file` → `read_file`, `sandbox_build` → `git_push`, etc.). El flujo obligatorio también cambia — ya no hay build ni deploy desde el agente:

```
FLUJO OBLIGATORIO:
1. read_file  — leer archivo antes de modificar
2. write_file — escribir el archivo completo con cambios
3. git_push   — commitear y pushear (el CI buildea y deploya automáticamente)
4. Confirmar al usuario: "✅ Pusheado. El CI está desplegando, en ~5min podés verlo en [url]"
```

El system prompt se pasa al pod en el campo `systemPrompt` del primer POST `/chat`.

### Endpoints HTTP del pod

```
POST /chat     { message, history, systemPrompt }  → SSE stream
GET  /health   → { status: 'ok' | 'ready' | 'idle' }
```

#### Formato SSE (idéntico al protocolo actual del back)

```
{ type: 'thinking' }
{ type: 'tool_start', name: 'write_file', args: {...} }
{ type: 'tool_done',  name: 'write_file', result: {...} }
{ type: 'pushed',     commit: 'abc123', message: 'add sidebar' }
{ type: 'done',       content: '✅ Listo, probalo: ...' }
{ type: 'error',      message: '...' }
```

### Inactividad y shutdown

- El pod trackea `lastActivity` internamente (timestamp del último `/chat`)
- Timer interno: cada 5 min chequea si `now - lastActivity > 60min` → inicia shutdown
- Safety net: cron del back-end busca sesiones idle > 70 min → `deleteSessionPod`

#### Shutdown graceful (SIGTERM, grace period 30s)

```
1. Si hay cambios sin pushear → git push "session end: auto-push"
2. POST {BACK_URL}/api/internal/sessions/{SESSION_ID}/end
   body: { filesChanged: [...], commitCount: N, summary: "..." }
3. exit(0)
```

---

## Back-end: cambios

### Nuevo modelo Prisma — `Session`

```prisma
model Session {
  id           String   @id @default(cuid())
  userId       String
  projectId    String
  podName      String
  podIP        String?
  status       String   @default("starting") // starting | ready | idle | dead
  filesChanged String[] @default([])
  commitCount  Int      @default(0)
  summary      String?
  lastActivity DateTime @default(now())
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id])
  project      Project  @relation(fields: [projectId], references: [id])
  isActive     Boolean  @default(true)
  @@unique([userId, projectId, isActive])
}
```

El flag `isActive` permite múltiples sesiones históricas (dead) por proyecto con una sola activa. Al crear sesión nueva se marca la anterior como `isActive: false`. Al buscar: `where: { userId, projectId, isActive: true }`.

### Nuevo archivo `back/src/lib/k8s.js`

Usa `@kubernetes/client-node` con in-cluster config (ServiceAccount token montado automáticamente en el pod del back).

```js
// Operaciones expuestas:
createSessionPod(sessionId, repoUrl, userId)  // → podName
waitForPodReady(podName, timeoutMs = 60000)   // → podIP
deleteSessionPod(podName)
getPodStatus(podName)                          // → 'Pending'|'Running'|'Succeeded'|'Failed'
```

#### Pod spec generado

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: session-{sessionId}
  namespace: sandbox-sessions
  labels:
    app: session-agent
    sessionId: {sessionId}
    userId: {userId}
spec:
  restartPolicy: Never
  terminationGracePeriodSeconds: 30
  serviceAccountName: session-agent-sa
  containers:
    - name: agent
      image: swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest
      ports:
        - containerPort: 3200
      env:
        - name: REPO_URL
          value: {repoUrlWithAuth}
        - name: LITELLM_URL
          value: http://172.30.200.101:4000
        - name: LITELLM_KEY
          valueFrom:
            secretKeyRef:
              name: back-secret
              key: LITELLM_KEY
        - name: SESSION_ID
          value: {sessionId}
        - name: BACK_URL
          value: http://back.allaria-hub.svc.cluster.local:3098
      resources:
        requests:
          cpu: "100m"
          memory: "256Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
```

### Nuevas rutas en el back

```
POST   /api/projects/:id/session         Inicia o retorna sesión activa
GET    /api/projects/:id/session         Estado de la sesión activa
DELETE /api/projects/:id/session         Mata la sesión (workspace cerrado)
POST   /api/internal/sessions/:id/end   Recibe resumen del pod al morir (internal)
```

### Modificación en `proxy.js` — `/api/chat/stream`

Detección: si el request incluye `projectId`, es un workspace session.

```
Flujo actual (sin projectId):
  → LiteLLM loop con tools → SSE al front

Flujo nuevo (con projectId):
  → busca Session activa en DB
  → si no existe o está dead → crea pod, guarda en DB
  → waitForPodReady (hasta 60s — el pod tarda ~35s en git clone + npm install)
  → si pod no está listo, streama { type: 'thinking', message: 'Preparando el agente...' } al front
  → POST http://{podIP}:3200/chat con { message, history, systemPrompt }
  → pipe SSE del pod al front
  → si evento { type: 'pushed' } → lanza pollGitlabPipeline() en paralelo
    → streama eventos de CI al front como tool_progress
```

### Cron de limpieza (amplía el reconciliation job existente)

Agrega un tercer pass al job que ya corre cada 5 min:

```
Pass 3: sesiones
  → busca Sessions con status != 'dead' y lastActivity < ahora - 70min
  → deleteSessionPod(podName) para cada una
  → marca status = 'dead' en DB
```

---

## K8s: nuevos recursos

### `k8s/session-rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: hub-back
  namespace: allaria-hub
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: session-manager
  namespace: sandbox-sessions
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: hub-back-session-manager
  namespace: sandbox-sessions
subjects:
  - kind: ServiceAccount
    name: hub-back
    namespace: allaria-hub
roleRef:
  kind: Role
  name: session-manager
  apiGroup: rbac.authorization.k8s.io
```

### `k8s/back-deployment.yaml`

Agregar `serviceAccountName: hub-back` al pod spec del back.

---

## Frontend: cambios en `ProjectWorkspace.jsx`

### 1. Spawn del pod al montar

```js
useEffect(() => {
  if (!project?.id) return
  api.startSession(project.id)  // POST /api/projects/:id/session — fire and forget
}, [project?.id])
```

### 2. `projectId` en el body del stream

```js
// Agregar al body del POST /api/chat/stream:
projectId: project.id
```

### 3. Limpieza al desmontar (opcional)

```js
useEffect(() => {
  return () => api.endSession(project.id)  // DELETE /api/projects/:id/session
}, [project?.id])
```

No es crítico — el pod muere solo por inactividad. Pero si el usuario cierra el workspace explícitamente, libera el pod inmediatamente.

---

## Registro de sesión

Dos capas sin overhead adicional:

- **Git history:** cada `git_push` del agente genera commits con mensajes descriptivos. Es el log detallado y ya existe.
- **DB `Session`:** al cerrar, el pod reporta `filesChanged`, `commitCount` y `summary`. El workspace puede mostrar "última sesión: hace 2 días — 3 commits".

No se escribe CHANGELOG.md automático. El historial de git ya cumple esa función.

---

## Flujo de vida completo

```
Workspace abre
  → POST /api/projects/:id/session
  → back: crea pod en sandbox-sessions namespace
  → pod: git clone + npm install (~35s)
  → pod: status 'ready'

Usuario chatea
  → back proxea mensajes al pod
  → pod streama SSE al front
  → git push → CI buildea y deploya

Inactividad 60 min
  → pod: auto-push si hay cambios pendientes → POST .../end → exit
  → back cron: deleteSessionPod → session 'dead'

Usuario vuelve
  → nuevo pod se levanta
  → git clone trae el último commit
  → historial del chat viene de DB como siempre
```

---

## Lo que NO cambia

- Protocolo SSE frontend ↔ back
- GitLab CI pipeline de proyectos
- sandbox-nginx y routing de proyectos
- Creación de proyectos (scaffold + GitLab repo) — sigue en el back-end actual
- El sandbox-agent sigue corriendo para crear proyectos nuevos hasta que Phase 3 lo reemplace

---

## Nuevos archivos

```
sandbox-agent/session-agent/          Pod image (nuevo servicio)
  src/index.js                        Express server + agent loop
  src/tools.js                        5 tools: read/write/list/bash/git_push
  src/git.js                          git clone, commit, push helpers
  Dockerfile
  package.json

back/src/lib/k8s.js                   K8s client (createPod, waitReady, delete)
back/src/routes/sessions.js           Rutas /api/projects/:id/session

k8s/session-rbac.yaml                 ServiceAccount + Role + RoleBinding
```

## Archivos modificados

```
back/src/routes/proxy.js              Detectar projectId → proxy al pod
back/src/routes/index.js              Registrar sessionsRouter
back/prisma/schema.prisma             Agregar model Session
k8s/back-deployment.yaml              serviceAccountName: hub-back
front/src/pages/ProjectWorkspace.jsx  startSession al montar, projectId en stream
front/src/lib/api.js                  startSession(), endSession()
```
