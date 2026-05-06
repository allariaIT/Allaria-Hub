# Sandbox Reliability & Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical, serious, and moderate bugs in the sandbox/hub flow, with the central change being a fully async `sandbox_build` that no longer blocks the SSE stream.

**Architecture:** The sandbox-agent's build endpoint responds immediately and runs Docker build in background (matching the existing creation pattern). The backend polls for completion via `sandboxStatus()`. All other fixes are surgical changes in their respective files with no architectural impact.

**Tech Stack:** Node.js/Express 5, Dockerode, Prisma/PostgreSQL, React 19/Vite, SSE streaming, GitLab API

---

## File Map

| File | Changes |
|------|---------|
| `sandbox-agent/src/lib/docker.js` | Reserved ports set, remove dangling images, demultiplex execInContainer |
| `sandbox-agent/src/lib/git.js` | spawnSync for commit message (injection fix), timeouts on all ops |
| `sandbox-agent/src/lib/scaffold.js` | Dockerfile: `npm install --package-lock-only` + `npm ci` |
| `sandbox-agent/src/routes/projects.js` | `POST /build` → async (respond immediately, build in background) |
| `back/src/lib/sandbox-client.js` | `AbortSignal.timeout(10_000)` on all requests |
| `back/src/lib/sandbox-tools.js` | `sandbox_build`: async polling; `sandbox_create_project`: polling + rollback; import `deleteGitlabRepo` |
| `back/src/lib/tools.js` | Add `workspaceSandbox` connector (excludes `sandbox_create_project`) |
| `back/src/routes/proxy.js` | `MAX_TOOL_ROUNDS = 10` |
| `back/src/index.js` | Reconciliation second pass: running→stopped for dead containers |
| `front/src/pages/ProjectWorkspace.jsx` | Auto-refresh on creating, interrupted timeout, handleRetry guard, `CONNECTORS = ['workspaceSandbox']`, system prompt rule |

---

## Task 1: docker.js — Reserved ports + dangling images + execInContainer demultiplex

**Files:**
- Modify: `sandbox-agent/src/lib/docker.js`

- [ ] **Step 1: Reemplazar el contenido de docker.js**

```js
import Docker from 'dockerode'

const docker = new Docker()

export function containerName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}`
}

export function imageName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}:latest`
}

// Puertos reservados por builds en curso (previene race condition)
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

export async function getUsedPorts() {
  const containers = await docker.listContainers({ all: true })
  const used = new Set()
  for (const c of containers) {
    if (c.Names.some(n => n.startsWith('/sandbox-'))) {
      for (const p of (c.Ports || [])) {
        if (p.PublicPort) used.add(p.PublicPort)
      }
    }
  }
  return used
}

export async function buildImage(contextDir, tag) {
  const stream = await docker.buildImage(
    { context: contextDir, src: ['.'] },
    { t: tag }
  )
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) reject(err)
      else resolve(output)
    })
  })
}

export async function runContainer(name, imageTag, hostPort) {
  // Remove existing container if any
  try {
    const existing = docker.getContainer(name)
    await existing.stop().catch(() => {})
    await existing.remove()
  } catch {
    // Container doesn't exist, fine
  }

  // Remove dangling image from previous build
  try {
    await docker.getImage(imageTag).remove({ force: true })
  } catch {
    // Image doesn't exist yet or in use — fine
  }

  const container = await docker.createContainer({
    Image: imageTag,
    name,
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostPort: String(hostPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
    },
    ExposedPorts: { '80/tcp': {} },
  })
  await container.start()
  return container
}

export async function stopContainer(name) {
  try {
    const container = docker.getContainer(name)
    await container.stop()
    await container.remove()
  } catch {
    // Already stopped/removed
  }
}

export async function getContainerStatus(name) {
  try {
    const container = docker.getContainer(name)
    const info = await container.inspect()
    return info.State.Running ? 'running' : 'stopped'
  } catch {
    return 'stopped'
  }
}

export async function execInContainer(name, cmd) {
  const container = docker.getContainer(name)
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  })
  const stream = await exec.start()
  return new Promise((resolve, reject) => {
    let output = ''
    stream.on('data', (chunk) => {
      // Docker multiplexes stdout/stderr with an 8-byte header per frame
      let offset = 0
      while (offset + 8 <= chunk.length) {
        const frameSize = chunk.readUInt32BE(offset + 4)
        const end = offset + 8 + frameSize
        if (end > chunk.length) break
        output += chunk.slice(offset + 8, end).toString()
        offset = end
      }
    })
    stream.on('end', () => resolve(output))
    stream.on('error', reject)
  })
}
```

- [ ] **Step 2: Verificar que el módulo no tiene errores de sintaxis**

```bash
cd ~/Allaria-Hub/sandbox-agent && node --input-type=module < src/lib/docker.js 2>&1 | head -5
```
Esperado: sin errores (o vacío). Si hay error de sintaxis aparece en stderr.

- [ ] **Step 3: Commit**

```bash
cd ~/Allaria-Hub && git add sandbox-agent/src/lib/docker.js && git commit -m "fix(sandbox): reserved ports, remove dangling images, demultiplex exec stream"
```

---

## Task 2: git.js — spawnSync para commit message + timeouts

**Files:**
- Modify: `sandbox-agent/src/lib/git.js`

- [ ] **Step 1: Reemplazar el contenido de git.js**

```js
import { execSync, spawnSync } from 'node:child_process'

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', timeout: 30000 }).toString().trim()
}

export function gitInit(projectDir, repoUrl) {
  run('git init', projectDir)
  run('git checkout -b main', projectDir)
  if (repoUrl) {
    run(`git remote add origin ${repoUrl}`, projectDir)
  }
}

export function gitCommitAndPush(projectDir, message) {
  run('git add -A', projectDir)
  // Usar spawnSync con array de args para evitar inyección de shell
  const commitResult = spawnSync('git', ['commit', '-m', message], {
    cwd: projectDir,
    stdio: 'pipe',
    timeout: 30000,
    encoding: 'utf-8',
  })
  if (commitResult.status !== 0) {
    return { pushed: false, message: 'Nada para commitear' }
  }
  try {
    run('git push -u origin main', projectDir)
    return { pushed: true }
  } catch (err) {
    return { pushed: false, message: err.message }
  }
}
```

- [ ] **Step 2: Verificar sintaxis**

```bash
cd ~/Allaria-Hub/sandbox-agent && node --input-type=module < src/lib/git.js 2>&1 | head -5
```
Esperado: sin errores.

- [ ] **Step 3: Commit**

```bash
cd ~/Allaria-Hub && git add sandbox-agent/src/lib/git.js && git commit -m "fix(sandbox): spawnSync para commit message previene inyeccion de shell, timeouts en git ops"
```

---

## Task 3: scaffold.js — Dockerfile determinístico con npm ci

**Files:**
- Modify: `sandbox-agent/src/lib/scaffold.js`

- [ ] **Step 1: Cambiar el Dockerfile en generateScaffold**

Reemplazar el bloque del Dockerfile dentro de `generateScaffold`. El archivo completo queda así (solo cambia el Dockerfile):

```js
import fs from 'node:fs'
import path from 'node:path'

export function generateScaffold(projectDir, { name, title, userSlug }) {
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })

  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name,
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.0.0',
      vite: '^6.0.0',
    },
  }, null, 2))

  fs.writeFileSync(path.join(projectDir, 'vite.config.js'),
`import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/${userSlug}/${name}/',
})
`)

  fs.writeFileSync(path.join(projectDir, 'Dockerfile'),
`FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --package-lock-only
COPY . .
RUN npm ci
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
`)

  fs.writeFileSync(path.join(projectDir, 'nginx.conf'),
`server {
    listen 80;

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
`)

  fs.writeFileSync(path.join(projectDir, '.dockerignore'),
`node_modules
dist
.git
`)

  fs.writeFileSync(path.join(projectDir, 'index.html'),
`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'main.jsx'),
`import { createRoot } from 'react-dom/client'
import App from './App'
import './App.css'

createRoot(document.getElementById('root')).render(<App />)
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'App.jsx'),
`export default function App() {
  return (
    <div className="app">
      <h1>${title}</h1>
      <p>Proyecto creado con Allaria Hub Sandbox</p>
    </div>
  )
}
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'App.css'),
`* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #fafafa; }
.app { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; }
h1 { font-size: 2.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
p { color: #888; }
`)
}
```

- [ ] **Step 2: Verificar sintaxis**

```bash
cd ~/Allaria-Hub/sandbox-agent && node --input-type=module < src/lib/scaffold.js 2>&1 | head -5
```
Esperado: sin errores.

- [ ] **Step 3: Commit**

```bash
cd ~/Allaria-Hub && git add sandbox-agent/src/lib/scaffold.js && git commit -m "fix(sandbox): dockerfile usa npm ci con lockfile generado en build stage"
```

---

## Task 4: sandbox-agent routes/projects.js — Build endpoint async

**Files:**
- Modify: `sandbox-agent/src/routes/projects.js`

El cambio principal es que `POST /:user/:name/build` responde inmediatamente con `{ ok: true, status: 'building' }` y corre el Docker build en background. También se agrega `releaseReservedPort` en el create flow.

- [ ] **Step 1: Agregar import de releaseReservedPort y modificar el endpoint build**

Cambiar la línea de import de docker:
```js
// Antes:
import { buildImage, runContainer, stopContainer, getUsedPorts, findFreePort, containerName, imageName, getContainerStatus, execInContainer } from '../lib/docker.js'
// Después:
import { buildImage, runContainer, stopContainer, getUsedPorts, findFreePort, releaseReservedPort, containerName, imageName, getContainerStatus, execInContainer } from '../lib/docker.js'
```

- [ ] **Step 2: En el background build del POST / (create), llamar releaseReservedPort después de runContainer**

En el bloque `async () => { ... }` del `POST /` (líneas ~96-116), agregar `releaseReservedPort(port)` justo después de `await runContainer(...)`. Si hay error, también liberar el puerto en el catch:

```js
// 6. Build en background con semáforo
;(async () => {
  await acquireBuildSlot()
  console.log(`[sandbox] ${userSlug}/${name} build iniciado (activos: ${activeBuilds}/${MAX_CONCURRENT_BUILDS})`)
  try {
    const imgTag = imageName(userSlug, name)
    await buildImage(projectDir, imgTag)
    await runContainer(containerName(userSlug, name), imgTag, port)
    releaseReservedPort(port) // Docker ya tiene el puerto bindeado
    await writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())
    gitCommitAndPush(projectDir, 'Initial scaffold')

    const check = await waitForContainer(port)
    const finalStatus = check.ok ? 'running' : 'error'
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: finalStatus }, null, 2))
    console.log(`[sandbox] ${userSlug}/${name} build: ${finalStatus}`)
  } catch (err) {
    releaseReservedPort(port) // Liberar puerto si el build falló
    console.error(`[sandbox] ${userSlug}/${name} build error:`, err.message)
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: err.message }, null, 2))
  } finally {
    releaseBuildSlot()
  }
})()
```

- [ ] **Step 3: Reemplazar el handler POST /:user/:name/build (síncrono → async)**

Reemplazar el bloque completo del endpoint `POST /:user/:name/build` (líneas ~244-274) con:

```js
// POST /projects/:user/:name/build - Rebuild container (async)
projectsRouter.post('/:user/:name/build', async (req, res) => {
  try {
    const { user, name } = req.params
    const projectDir = path.join(PROJECTS_DIR, user, name)
    const metaPath = path.join(projectDir, '.sandbox-meta.json')
    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Proyecto no encontrado' })
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    // Marcar como building y responder inmediatamente
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'building' }, null, 2))
    res.json({ ok: true, port: meta.port, status: 'building' })

    // Build en background
    ;(async () => {
      await acquireBuildSlot()
      console.log(`[sandbox] ${user}/${name} rebuild iniciado`)
      try {
        const imgTag = imageName(user, name)
        await buildImage(projectDir, imgTag)
        await runContainer(containerName(user, name), imgTag, meta.port)
        await writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())

        const check = await waitForContainer(meta.port)
        const finalStatus = check.ok ? 'running' : 'error'
        fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: finalStatus }, null, 2))
        console.log(`[sandbox] ${user}/${name} rebuild: ${finalStatus}`)
      } catch (err) {
        console.error(`[sandbox] ${user}/${name} rebuild error:`, err.message)
        fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: err.message }, null, 2))
      } finally {
        releaseBuildSlot()
      }
    })()
  } catch (err) {
    console.error('Build error:', err)
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Verificar sintaxis**

```bash
cd ~/Allaria-Hub/sandbox-agent && node --input-type=module < src/routes/projects.js 2>&1 | head -5
```
Esperado: sin errores.

- [ ] **Step 5: Commit**

```bash
cd ~/Allaria-Hub && git add sandbox-agent/src/routes/projects.js && git commit -m "fix(sandbox): build endpoint async, liberar puerto reservado post-build"
```

---

## Task 5: sandbox-client.js — Timeout en todas las requests

**Files:**
- Modify: `back/src/lib/sandbox-client.js`

- [ ] **Step 1: Reemplazar el contenido de sandbox-client.js**

```js
// back/src/lib/sandbox-client.js
const SANDBOX_AGENT_URL = process.env.SANDBOX_AGENT_URL || 'http://172.30.200.101:3100'
const SANDBOX_AGENT_KEY = process.env.SANDBOX_AGENT_KEY

async function sandboxRequest(path, options = {}, timeoutMs = 10_000) {
  const res = await fetch(`${SANDBOX_AGENT_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'X-Sandbox-Key': SANDBOX_AGENT_KEY,
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Sandbox agent error')
  return data
}

export async function sandboxCreateProject(userSlug, name, title, repoUrl) {
  return sandboxRequest('/projects', {
    method: 'POST',
    body: JSON.stringify({ userSlug, name, title, repoUrl }),
  })
}

export async function sandboxWriteFile(userSlug, name, filePath, content) {
  return sandboxRequest(`/projects/${userSlug}/${name}/files`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath, content }),
  })
}

export async function sandboxReadFile(userSlug, name, filePath) {
  return sandboxRequest(`/projects/${userSlug}/${name}/files/${filePath}`)
}

export async function sandboxListFiles(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}/tree`)
}

export async function sandboxBuild(userSlug, name) {
  // Build es async ahora — el endpoint responde inmediatamente
  return sandboxRequest(`/projects/${userSlug}/${name}/build`, { method: 'POST' })
}

export async function sandboxPush(userSlug, name, message) {
  return sandboxRequest(`/projects/${userSlug}/${name}/push`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
}

export async function sandboxStatus(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}`)
}

export async function sandboxDelete(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}`, { method: 'DELETE' })
}

export async function sandboxStop(userSlug, name) {
  return sandboxRequest(`/projects/${userSlug}/${name}/stop`, { method: 'POST' })
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Allaria-Hub && git add back/src/lib/sandbox-client.js && git commit -m "fix(back): timeout 10s en todas las requests al sandbox agent"
```

---

## Task 6: sandbox-tools.js — sandbox_build async con polling + sandbox_create_project rollback

**Files:**
- Modify: `back/src/lib/sandbox-tools.js`

- [ ] **Step 1: Agregar import de deleteGitlabRepo**

Cambiar la línea de import de gitlab al inicio del archivo:
```js
// Antes:
import { createGitlabRepo } from './gitlab.js'
// Después:
import { createGitlabRepo, deleteGitlabRepo } from './gitlab.js'
```

- [ ] **Step 2: Reemplazar case 'sandbox_build' en executeSandboxTool**

El case anterior era:
```js
case 'sandbox_build': {
  const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
  if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
  await sandboxBuild(userSlug, args.projectName)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
  return { ok: true, message: 'Build completado. Preview actualizada.', previewUrl: project.previewUrl }
}
```

Reemplazar con:
```js
case 'sandbox_build': {
  const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
  if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)

  // Disparar build (responde inmediatamente ahora)
  await sandboxBuild(userSlug, args.projectName)

  // Polling hasta que el sandbox confirme running o error
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000))
    try {
      const status = await sandboxStatus(userSlug, args.projectName)
      if (status.status === 'running') {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
        return { ok: true, message: 'Build completado. Preview actualizada.', previewUrl: project.previewUrl }
      }
      if (status.status === 'error') {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        return { ok: false, message: 'El build falló. Revisá los archivos del proyecto.' }
      }
    } catch {}
  }

  // Timeout después de 20 × 6s = 2 minutos
  await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
  return { ok: false, message: 'Timeout esperando el build (2 minutos). El proyecto puede estar en error.' }
}
```

- [ ] **Step 3: Reemplazar case 'sandbox_create_project' en executeSandboxTool**

El case anterior marcaba `status: 'running'` inmediatamente. Reemplazar con:
```js
case 'sandbox_create_project': {
  // 1. Crear repo en GitLab
  let gitlabId, repoUrl, webUrl
  try {
    const gitlab = await createGitlabRepo(userSlug, args.name)
    gitlabId = gitlab.gitlabId
    repoUrl = gitlab.repoUrl
    webUrl = gitlab.webUrl
  } catch (err) {
    throw new Error(`Error creando repo en GitLab: ${err.message}`)
  }

  // 2. Crear en DB
  let project
  try {
    project = await prisma.project.create({
      data: {
        name: args.name,
        title: args.title,
        description: args.description || null,
        userId,
        gitlabId,
        repoUrl: webUrl,
        status: 'creating',
        template: 'vite-react',
      },
    })
  } catch (err) {
    // Rollback GitLab
    try { await deleteGitlabRepo(gitlabId) } catch {}
    throw err
  }

  // 3. Crear chat dedicado
  let chatId = project.chatId
  if (!chatId) {
    const chat = await prisma.chat.create({
      data: { title: `🚧 ${args.title}`, userId },
    })
    chatId = chat.id
  }

  // 4. Llamar al sandbox agent
  let port
  try {
    const result = await sandboxCreateProject(userSlug, args.name, args.title, repoUrl)
    port = result.port
  } catch (err) {
    // Rollback DB + GitLab
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {})
    try { await deleteGitlabRepo(gitlabId) } catch {}
    throw new Error(`Error al iniciar el sandbox: ${err.message}`)
  }

  const previewUrl = `${PREVIEW_BASE}/${userSlug}/${args.name}/`
  await prisma.project.update({
    where: { id: project.id },
    data: { port, previewUrl, chatId, status: 'creating' },
  })

  // 5. Polling para esperar que el build termine
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000))
    try {
      const status = await sandboxStatus(userSlug, args.name)
      if (status.status === 'running') {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
        return {
          message: `Proyecto "${args.title}" creado exitosamente.`,
          previewUrl,
          repoUrl: webUrl,
          status: 'running',
        }
      }
      if (status.status === 'error') {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
        return {
          message: `Proyecto "${args.title}" tuvo un error al buildear.`,
          previewUrl,
          status: 'error',
        }
      }
    } catch {}
  }

  await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } }).catch(() => {})
  return {
    message: `Timeout esperando que "${args.title}" esté listo. El proyecto puede estar en error.`,
    status: 'error',
  }
}
```

- [ ] **Step 4: Verificar sintaxis**

```bash
cd ~/Allaria-Hub/back && node --input-type=module < src/lib/sandbox-tools.js 2>&1 | head -5
```
Esperado: sin errores (o solo warnings de imports que no se pueden resolver fuera del contexto).

- [ ] **Step 5: Commit**

```bash
cd ~/Allaria-Hub && git add back/src/lib/sandbox-tools.js && git commit -m "fix(back): sandbox_build async con polling, sandbox_create_project rollback en fallo"
```

---

## Task 7: tools.js — Connector workspaceSandbox

**Files:**
- Modify: `back/src/lib/tools.js`

- [ ] **Step 1: Agregar WORKSPACE_SANDBOX_TOOL_DEFINITIONS y el conector workspaceSandbox**

Justo después de la línea `import { SANDBOX_TOOL_DEFINITIONS, executeSandboxTool } from './sandbox-tools.js'`, agregar:

```js
// Tools de sandbox disponibles en el workspace (excluye sandbox_create_project)
const WORKSPACE_SANDBOX_TOOL_DEFINITIONS = SANDBOX_TOOL_DEFINITIONS.filter(
  t => t.function.name !== 'sandbox_create_project'
)
```

En el objeto `TOOL_DEFINITIONS`, después de `sandbox: SANDBOX_TOOL_DEFINITIONS,`, agregar:
```js
workspaceSandbox: WORKSPACE_SANDBOX_TOOL_DEFINITIONS,
```

No se modifica `executeTool` — el routing a `executeSandboxTool` ya maneja todos los nombres de sandbox tools. Si el LLM no tiene `sandbox_create_project` en sus tools disponibles, nunca lo llamará.

- [ ] **Step 2: Commit**

```bash
cd ~/Allaria-Hub && git add back/src/lib/tools.js && git commit -m "feat(back): connector workspaceSandbox sin sandbox_create_project"
```

---

## Task 8: proxy.js — MAX_TOOL_ROUNDS = 10

**Files:**
- Modify: `back/src/routes/proxy.js`

- [ ] **Step 1: Cambiar MAX_TOOL_ROUNDS**

Buscar la línea:
```js
const MAX_TOOL_ROUNDS = 5
```
Cambiarla a:
```js
const MAX_TOOL_ROUNDS = 10
```
Esta constante aparece una sola vez en el archivo (línea 9). Cambiarla aquí afecta los tres handlers: `/completions`, `/stream`, y `/confirm`.

- [ ] **Step 2: Commit**

```bash
cd ~/Allaria-Hub && git add back/src/routes/proxy.js && git commit -m "fix(back): aumentar MAX_TOOL_ROUNDS a 10 para tareas con múltiples archivos"
```

---

## Task 9: index.js — Reconciliation detecta containers eliminados

**Files:**
- Modify: `back/src/index.js`

- [ ] **Step 1: Agregar segundo pass en reconcileProjects**

Dentro de `reconcileProjects()`, después del loop existente (el que arregla `creating/error → running`), agregar el segundo pass:

```js
// Segundo pass: proyectos 'running' en DB cuyo container ya no existe
const runningProjects = await prisma.project.findMany({
  where: { status: 'running', port: { not: null } },
  include: { user: { select: { email: true } } },
})

for (const project of runningProjects) {
  try {
    const userSlug = slugFromEmail(project.user.email)
    const status = await sandboxStatus(userSlug, project.name)
    if (status.status !== 'running') {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } })
      console.log(`[reconcile] ${project.name} → stopped (container caído)`)
    }
  } catch {
    // 404 o error = el sandbox no tiene el container
    await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } }).catch(() => {})
    console.log(`[reconcile] ${project.name} → stopped (sandbox sin respuesta)`)
  }
}
```

El bloque completo de `reconcileProjects` queda así:

```js
async function reconcileProjects() {
  const slugFromEmail = (email) => email.split('@')[0].replace(/\./g, '-').toLowerCase()

  try {
    // Primer pass: creating/error → running (si el sandbox ya terminó el build)
    const stale = await prisma.project.findMany({
      where: { status: { in: ['creating', 'error'] }, port: { not: null } },
      include: { user: { select: { email: true } } },
    })

    if (stale.length > 0) {
      console.log(`[reconcile] Revisando ${stale.length} proyecto(s) en estado incompleto...`)
    }

    for (const project of stale) {
      try {
        const userSlug = slugFromEmail(project.user.email)
        const status = await sandboxStatus(userSlug, project.name)
        if (status.status === 'running') {
          await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
          console.log(`[reconcile] ${project.name} → running`)
        }
      } catch {
        // sandbox no tiene el proyecto o no responde — dejar como está
      }
    }

    // Segundo pass: running en DB pero container caído → stopped
    const runningProjects = await prisma.project.findMany({
      where: { status: 'running', port: { not: null } },
      include: { user: { select: { email: true } } },
    })

    for (const project of runningProjects) {
      try {
        const userSlug = slugFromEmail(project.user.email)
        const status = await sandboxStatus(userSlug, project.name)
        if (status.status !== 'running') {
          await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } })
          console.log(`[reconcile] ${project.name} → stopped (container caído)`)
        }
      } catch {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } }).catch(() => {})
        console.log(`[reconcile] ${project.name} → stopped (sandbox 404)`)
      }
    }
  } catch (err) {
    console.error('[reconcile] Error:', err.message)
  }

  setTimeout(reconcileProjects, 5 * 60 * 1000)
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Allaria-Hub && git add back/src/index.js && git commit -m "fix(back): reconciliation detecta proyectos running cuyo container fue eliminado"
```

---

## Task 10: ProjectWorkspace.jsx — Auto-refresh creating, interrupted timeout, handleRetry guard, workspaceSandbox

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.jsx`

- [ ] **Step 1: Cambiar CONNECTORS a workspaceSandbox**

Buscar la línea:
```js
const CONNECTORS = ['sandbox']
```
Cambiarla a:
```js
const CONNECTORS = ['workspaceSandbox']
```

- [ ] **Step 2: Agregar regla al SANDBOX_SYSTEM_PROMPT**

Agregar una quinta regla al system prompt:
```js
const SANDBOX_SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLAS IMPORTANTES:
1. Cuando el usuario te pregunte "¿en qué estábamos?", "¿qué hicimos?", "¿qué hay hasta ahora?" o similar, leé PRIMERO el archivo CHANGELOG.md con sandbox_read_file. NO leas todos los archivos del proyecto ni hagas builds innecesarios.
2. Cada vez que modifiques archivos, al final SIEMPRE actualizá CHANGELOG.md agregando una entrada con: fecha, qué se cambió y por qué. Usá formato markdown simple.
3. Después de modificar archivos, SIEMPRE llamá sandbox_build para deployar los cambios.
4. Para pushear a GitLab usá sandbox_push cuando el usuario lo pida.
5. NO creés proyectos nuevos. Solo trabajás dentro del proyecto activo indicado abajo.

Tools disponibles: sandbox_write_file, sandbox_read_file, sandbox_list_files, sandbox_build, sandbox_push, sandbox_status.`
```

- [ ] **Step 3: Agregar polling de auto-refresh cuando status === 'creating'**

Agregar el siguiente `useEffect` después del `useEffect` de load inicial (después de la línea `}, [id])`):

```js
// Auto-refresh: si el proyecto está creando, esperar a que esté running
useEffect(() => {
  if (project?.status !== 'creating') return
  const interval = setInterval(async () => {
    try {
      const updated = await api.getProject(id)
      if (updated.status !== 'creating') {
        setProject(updated)
      }
    } catch {}
  }, 5000)
  return () => clearInterval(interval)
}, [project?.status, id])
```

- [ ] **Step 4: Actualizar la pantalla de 'creating' para mostrar que está esperando**

Reemplazar el bloque:
```js
if (project?.status === 'creating') return (
  <div className="pw-error">
    <Loader2 size={32} className="pw-spin" style={{ color: '#eab308' }} />
    <p style={{ marginTop: '1rem', fontWeight: 600 }}>El proyecto se está creando...</p>
    <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Esto puede tardar hasta un minuto. Volvé en unos segundos.</p>
    <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/proyectos')}>Volver al hub</button>
  </div>
)
```
Con:
```js
if (project?.status === 'creating') return (
  <div className="pw-error">
    <Loader2 size={32} className="pw-spin" style={{ color: '#eab308' }} />
    <p style={{ marginTop: '1rem', fontWeight: 600 }}>El proyecto se está creando...</p>
    <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Esto puede tardar hasta un minuto. El workspace abre automáticamente cuando esté listo.</p>
    <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => navigate('/proyectos')}>Volver al hub</button>
  </div>
)
```

- [ ] **Step 5: Agregar timeout máximo al polling de "interrumpido"**

Reemplazar el `useEffect` del polling interrumpido (el que tiene `if (!interrupted || sending || !chat) return`):

```js
useEffect(() => {
  if (!interrupted || sending || !chat) return
  let attempts = 0
  const interval = setInterval(async () => {
    attempts++
    if (attempts > 40) { // 40 × 3s = 2 minutos máximo
      setInterrupted(false)
      clearInterval(interval)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'No se recibió respuesta del servidor. Podés intentar enviar el mensaje de nuevo.',
      }])
      return
    }
    try {
      const chatData = await api.getProjectChat(id)
      const msgs = chatData.messages || []
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        setMessages(msgs)
        setInterrupted(false)
        clearInterval(interval)
      }
    } catch {}
  }, 3000)
  return () => clearInterval(interval)
}, [interrupted, sending, chat, id])
```

- [ ] **Step 6: Agregar guard en handleRetry**

Reemplazar:
```js
const handleRetry = () => {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
```
Con:
```js
const handleRetry = () => {
  if (sending) return
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
```

- [ ] **Step 7: Commit**

```bash
cd ~/Allaria-Hub && git add front/src/pages/ProjectWorkspace.jsx && git commit -m "fix(front): auto-refresh en creating, timeout polling interrumpido, guard handleRetry, workspaceSandbox connector"
```

---

## Task 11: Deploy y verificación

- [ ] **Step 1: Deploy sandbox-agent en el servidor sandbox**

```bash
# En 172.30.200.101
cd ~/Allaria-Hub/sandbox-agent && git pull && docker compose up -d --build
```

- [ ] **Step 2: Deploy app server**

```bash
# En 172.26.20.90
cd ~/Allaria-Hub && git pull && docker compose up -d --build
```

- [ ] **Step 3: Verificar creación de proyecto via modal**

1. Abrir ia.allaria.xyz → Proyectos → Crear Proyecto
2. Crear un proyecto nuevo
3. El modal debe cerrarse, la tarjeta aparece con status "Creando..."
4. Sin recargar, en ~1-2 minutos el status debe cambiar a "Activo"

- [ ] **Step 4: Verificar que el workspace auto-refresca cuando creating**

1. Hacer click en una tarjeta en "Creando..." (si hubiera alguna)
2. El workspace debe mostrar el spinner con "El workspace abre automáticamente..."
3. Cuando el proyecto termina, el workspace debe cargar sin necesitar navegar

- [ ] **Step 5: Verificar rebuild vía LLM en workspace**

1. Abrir el workspace de un proyecto running
2. Pedir al LLM: "Cambiá el texto del h1 a 'Hola Mundo'"
3. El LLM debe: escribir el archivo → llamar sandbox_build → esperar polling → confirmar "Build completado"
4. El SSE no debe morir durante el build (el chat sigue respondiendo)

- [ ] **Step 6: Verificar dos proyectos creados simultáneamente**

1. Crear dos proyectos casi al mismo tiempo (dos tabs del navegador)
2. Verificar en logs del sandbox que cada uno recibe un puerto diferente
3. Ambos deben llegar a status "Activo"

- [ ] **Step 7: Verificar reconciliation segunda pasada**

1. En el servidor sandbox: `docker stop sandbox-<user>-<name>`
2. Esperar hasta 5 minutos (próxima corrida del reconciliation job)
3. En la UI, el proyecto debe aparecer como "Detenido" sin recargar manualmente

- [ ] **Step 8: Verificar que sandbox_create_project no está disponible en workspace**

1. En el workspace de cualquier proyecto, pedirle al LLM: "Creá un nuevo proyecto llamado test"
2. El LLM debe responder que no puede crear proyectos desde el workspace, no intentar llamar la tool

---

## Testing Checklist (del spec)

- [ ] Crear proyecto via modal → status evoluciona creating → running en UI sin recargar
- [ ] Crear proyecto via LLM chat → mismo comportamiento
- [ ] Modificar archivos + build via LLM → SSE no muere, LLM recibe resultado del build
- [ ] Build falla → status='error' en DB, LLM reporta el error
- [ ] Dos proyectos creados simultáneamente → no comparten puerto
- [ ] Eliminar container manualmente → reconciliation actualiza a 'stopped' en < 5 min
- [ ] Navegar al workspace de proyecto en 'creating' → auto-refresh al terminar
- [ ] Mensaje interrumpido → timeout a los 2 min con mensaje de error
- [ ] Commit message con caracteres especiales (comillas, backticks) → no hay inyección de shell
- [ ] Múltiples rebuilds seguidos → no hay dangling images acumuladas
- [ ] Tarea con 6+ archivos + build → LLM completa con MAX_TOOL_ROUNDS=10
