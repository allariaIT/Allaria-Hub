# Sandbox Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir a los usuarios crear proyectos web (Vite+React) desde el chat, con preview en vivo via containers Docker aislados y push a GitLab.

**Architecture:** Dos sistemas: (1) Sandbox Agent — servicio Express liviano en 172.30.200.101:3100 que maneja filesystem, Docker y nginx; (2) Integracion en Allaria Hub — backend (nuevo conector "sandbox" con tools para LiteLLM) y frontend (ConnectorPicker + pagina de Proyectos). El backend de Hub hace HTTP requests al Sandbox Agent, nunca ejecuta Docker directamente.

**Tech Stack:** Express 5, Prisma/PostgreSQL, Docker (dockerode), nginx, GitLab API, React 19, Vite 8

---

## Scope Note

Este plan tiene 3 fases independientes:
- **Fase 1 (Tasks 1-7):** Sandbox Agent — servicio nuevo, se puede desarrollar y testear aislado
- **Fase 2 (Tasks 8-12):** Allaria Hub Backend — conector sandbox, tools, rutas
- **Fase 3 (Tasks 13-15):** Allaria Hub Frontend — ConnectorPicker, pagina Proyectos, chat integration

---

## File Structure

### Sandbox Agent (nuevo servicio: `sandbox-agent/`)

| File | Responsabilidad |
|------|-----------------|
| `sandbox-agent/package.json` | Dependencias: express, dockerode, dotenv |
| `sandbox-agent/.env.example` | Variables de entorno |
| `sandbox-agent/src/index.js` | Entry point Express, middleware auth, rutas |
| `sandbox-agent/src/middleware/auth.js` | Validacion X-Sandbox-Key |
| `sandbox-agent/src/routes/projects.js` | CRUD proyectos, file ops, build, push |
| `sandbox-agent/src/lib/docker.js` | Build, run, stop, remove containers; port pool |
| `sandbox-agent/src/lib/nginx.js` | Generar y recargar config nginx |
| `sandbox-agent/src/lib/scaffold.js` | Templates Vite+React (archivos generados) |
| `sandbox-agent/src/lib/git.js` | git init, remote, commit, push |
| `sandbox-agent/tests/auth.test.js` | Tests middleware auth |
| `sandbox-agent/tests/scaffold.test.js` | Tests scaffold generation |
| `sandbox-agent/tests/docker.test.js` | Tests docker lib |
| `sandbox-agent/tests/nginx.test.js` | Tests nginx config generation |
| `sandbox-agent/tests/projects.test.js` | Tests integration endpoints |

### Allaria Hub Backend (archivos existentes + nuevos)

| File | Responsabilidad |
|------|-----------------|
| `back/prisma/schema.prisma` | Modify: agregar modelo Project + relacion User |
| `back/src/lib/sandbox-client.js` | Create: HTTP client al Sandbox Agent |
| `back/src/lib/gitlab.js` | Create: GitLab API client (crear repo) |
| `back/src/lib/sandbox-tools.js` | Create: Tool definitions + execution para sandbox |
| `back/src/lib/tools.js` | Modify: registrar sandbox tools |
| `back/src/routes/projects.js` | Create: REST API para proyectos del usuario |
| `back/src/index.js` | Modify: registrar ruta /api/projects |

### Allaria Hub Frontend

| File | Responsabilidad |
|------|-----------------|
| `front/src/components/ConnectorPicker.jsx` | Modify: agregar entrada sandbox |
| `front/src/pages/Chat.jsx` | Modify: system prompt sandbox, TOOL_ICONS/LABELS |
| `front/src/pages/Projects.jsx` | Create: pagina listado de proyectos |
| `front/src/pages/Projects.css` | Create: estilos pagina proyectos |
| `front/src/lib/api.js` | Modify: agregar endpoints proyectos |
| `front/src/App.jsx` | Modify: agregar ruta /projects |

---

## Fase 1: Sandbox Agent

### Task 1: Project setup + auth middleware

**Files:**
- Create: `sandbox-agent/package.json`
- Create: `sandbox-agent/.env.example`
- Create: `sandbox-agent/src/index.js`
- Create: `sandbox-agent/src/middleware/auth.js`
- Test: `sandbox-agent/tests/auth.test.js`

- [ ] **Step 1: Crear package.json**

```json
{
  "name": "sandbox-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "express": "^5.0.0",
    "dockerode": "^4.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Crear .env.example**

```
PORT=3100
SANDBOX_KEY=change-me-shared-secret
PROJECTS_DIR=/projects
NGINX_CONFIG_PATH=/etc/nginx/conf.d/sandbox-projects.conf
PORT_RANGE_START=4001
PORT_RANGE_END=4100
```

- [ ] **Step 3: Write failing test for auth middleware**

```javascript
// sandbox-agent/tests/auth.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createAuthMiddleware } from '../src/middleware/auth.js'

describe('auth middleware', () => {
  const auth = createAuthMiddleware('test-secret')

  it('rejects requests without X-Sandbox-Key', () => {
    let statusCode, body
    const req = { headers: {} }
    const res = {
      status(code) { statusCode = code; return this },
      json(data) { body = data },
    }
    const next = () => { throw new Error('should not call next') }

    auth(req, res, next)
    assert.strictEqual(statusCode, 401)
    assert.strictEqual(body.error, 'Unauthorized')
  })

  it('rejects requests with wrong key', () => {
    let statusCode, body
    const req = { headers: { 'x-sandbox-key': 'wrong' } }
    const res = {
      status(code) { statusCode = code; return this },
      json(data) { body = data },
    }
    const next = () => { throw new Error('should not call next') }

    auth(req, res, next)
    assert.strictEqual(statusCode, 401)
    assert.strictEqual(body.error, 'Unauthorized')
  })

  it('allows requests with correct key', () => {
    let called = false
    const req = { headers: { 'x-sandbox-key': 'test-secret' } }
    const res = {}
    const next = () => { called = true }

    auth(req, res, next)
    assert.strictEqual(called, true)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd sandbox-agent && npm install && node --test tests/auth.test.js`
Expected: FAIL — module not found

- [ ] **Step 5: Implement auth middleware**

```javascript
// sandbox-agent/src/middleware/auth.js
export function createAuthMiddleware(secretKey) {
  return (req, res, next) => {
    const key = req.headers['x-sandbox-key']
    if (!key || key !== secretKey) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd sandbox-agent && node --test tests/auth.test.js`
Expected: PASS (3/3)

- [ ] **Step 7: Create Express entry point**

```javascript
// sandbox-agent/src/index.js
import 'dotenv/config'
import express from 'express'
import { createAuthMiddleware } from './middleware/auth.js'
import { projectsRouter } from './routes/projects.js'

const app = express()
const PORT = process.env.PORT || 3100

app.use(express.json({ limit: '10mb' }))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

const auth = createAuthMiddleware(process.env.SANDBOX_KEY)
app.use('/projects', auth, projectsRouter)

app.listen(PORT, () => {
  console.log(`[Sandbox Agent] Running on port ${PORT}`)
})

export { app }
```

- [ ] **Step 8: Create stub router (para que el import no falle)**

```javascript
// sandbox-agent/src/routes/projects.js
import { Router } from 'express'

export const projectsRouter = Router()

// GET /projects - list all projects
projectsRouter.get('/', (req, res) => {
  res.json([])
})
```

- [ ] **Step 9: Commit**

```bash
git add sandbox-agent/
git commit -m "feat(sandbox-agent): project setup + auth middleware"
```

---

### Task 2: Scaffold generator

**Files:**
- Create: `sandbox-agent/src/lib/scaffold.js`
- Test: `sandbox-agent/tests/scaffold.test.js`

- [ ] **Step 1: Write failing test for scaffold**

```javascript
// sandbox-agent/tests/scaffold.test.js
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { generateScaffold } from '../src/lib/scaffold.js'

describe('generateScaffold', () => {
  let tmpDir

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates all expected files', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'test-project')

    generateScaffold(projectDir, {
      name: 'test-project',
      title: 'Test Project',
      userSlug: 'juan-perez',
    })

    assert.ok(fs.existsSync(path.join(projectDir, 'package.json')))
    assert.ok(fs.existsSync(path.join(projectDir, 'vite.config.js')))
    assert.ok(fs.existsSync(path.join(projectDir, 'Dockerfile')))
    assert.ok(fs.existsSync(path.join(projectDir, '.dockerignore')))
    assert.ok(fs.existsSync(path.join(projectDir, 'index.html')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'main.jsx')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'App.jsx')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'App.css')))
  })

  it('uses correct base path in vite config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'dashboard')

    generateScaffold(projectDir, {
      name: 'dashboard',
      title: 'Dashboard',
      userSlug: 'juan-perez',
    })

    const viteConfig = fs.readFileSync(path.join(projectDir, 'vite.config.js'), 'utf-8')
    assert.ok(viteConfig.includes("base: '/juan-perez/dashboard/'"))
  })

  it('uses project title in App.jsx', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'mi-app')

    generateScaffold(projectDir, {
      name: 'mi-app',
      title: 'Mi Aplicacion',
      userSlug: 'maria',
    })

    const appJsx = fs.readFileSync(path.join(projectDir, 'src', 'App.jsx'), 'utf-8')
    assert.ok(appJsx.includes('Mi Aplicacion'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sandbox-agent && node --test tests/scaffold.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement scaffold generator**

```javascript
// sandbox-agent/src/lib/scaffold.js
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
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sandbox-agent && node --test tests/scaffold.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add sandbox-agent/src/lib/scaffold.js sandbox-agent/tests/scaffold.test.js
git commit -m "feat(sandbox-agent): scaffold generator for Vite+React projects"
```

---

### Task 3: Docker manager (build, run, stop, port pool)

**Files:**
- Create: `sandbox-agent/src/lib/docker.js`
- Test: `sandbox-agent/tests/docker.test.js`

- [ ] **Step 1: Write failing test for port allocation**

```javascript
// sandbox-agent/tests/docker.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { findFreePort, containerName, imageName } from '../src/lib/docker.js'

describe('docker helpers', () => {
  it('containerName returns correct format', () => {
    assert.strictEqual(containerName('juan-perez', 'dashboard'), 'sandbox-juan-perez-dashboard')
  })

  it('imageName returns correct format', () => {
    assert.strictEqual(imageName('juan-perez', 'dashboard'), 'sandbox-juan-perez-dashboard:latest')
  })

  it('findFreePort returns first port when no containers running', async () => {
    // Mock: pass empty used ports set
    const port = findFreePort(new Set(), 4001, 4100)
    assert.strictEqual(port, 4001)
  })

  it('findFreePort skips used ports', () => {
    const used = new Set([4001, 4002, 4003])
    const port = findFreePort(used, 4001, 4100)
    assert.strictEqual(port, 4004)
  })

  it('findFreePort throws when all ports used', () => {
    const used = new Set([4001, 4002])
    assert.throws(
      () => findFreePort(used, 4001, 4002),
      /No hay puertos disponibles/
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sandbox-agent && node --test tests/docker.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement docker manager**

```javascript
// sandbox-agent/src/lib/docker.js
import Docker from 'dockerode'

const docker = new Docker()

export function containerName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}`
}

export function imageName(userSlug, projectName) {
  return `sandbox-${userSlug}-${projectName}:latest`
}

export function findFreePort(usedPorts, rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (!usedPorts.has(port)) return port
  }
  throw new Error('No hay puertos disponibles en el rango')
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
    stream.on('data', (chunk) => { output += chunk.toString() })
    stream.on('end', () => resolve(output))
    stream.on('error', reject)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sandbox-agent && node --test tests/docker.test.js`
Expected: PASS (5/5) — solo testea helpers puros, no Docker real

- [ ] **Step 5: Commit**

```bash
git add sandbox-agent/src/lib/docker.js sandbox-agent/tests/docker.test.js
git commit -m "feat(sandbox-agent): docker manager with port pool"
```

---

### Task 4: Nginx config generator

**Files:**
- Create: `sandbox-agent/src/lib/nginx.js`
- Test: `sandbox-agent/tests/nginx.test.js`

- [ ] **Step 1: Write failing test for nginx config generation**

```javascript
// sandbox-agent/tests/nginx.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { generateNginxConfig } from '../src/lib/nginx.js'

describe('generateNginxConfig', () => {
  it('generates valid server block with locations', () => {
    const projects = [
      { userSlug: 'juan-perez', name: 'dashboard', port: 4001 },
      { userSlug: 'maria-gomez', name: 'portal', port: 4002 },
    ]
    const config = generateNginxConfig(projects)

    assert.ok(config.includes('listen 3099'))
    assert.ok(config.includes('location /juan-perez/dashboard/'))
    assert.ok(config.includes('proxy_pass http://localhost:4001/'))
    assert.ok(config.includes('location /maria-gomez/portal/'))
    assert.ok(config.includes('proxy_pass http://localhost:4002/'))
  })

  it('generates empty server block when no projects', () => {
    const config = generateNginxConfig([])
    assert.ok(config.includes('listen 3099'))
    assert.ok(!config.includes('location /'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sandbox-agent && node --test tests/nginx.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement nginx config generator**

```javascript
// sandbox-agent/src/lib/nginx.js
import fs from 'node:fs'
import { execSync } from 'node:child_process'

export function generateNginxConfig(projects) {
  const locations = projects.map(p =>
    `    location /${p.userSlug}/${p.name}/ {
        proxy_pass http://localhost:${p.port}/;
    }`
  ).join('\n\n')

  return `server {
    listen 3099;

${locations}
}
`
}

export function writeAndReloadNginx(configPath, projects) {
  const config = generateNginxConfig(projects)
  fs.writeFileSync(configPath, config)
  try {
    execSync('nginx -s reload', { stdio: 'ignore' })
  } catch {
    console.warn('[nginx] Could not reload — is nginx running?')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sandbox-agent && node --test tests/nginx.test.js`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add sandbox-agent/src/lib/nginx.js sandbox-agent/tests/nginx.test.js
git commit -m "feat(sandbox-agent): nginx config generator"
```

---

### Task 5: Git operations

**Files:**
- Create: `sandbox-agent/src/lib/git.js`

- [ ] **Step 1: Implement git operations**

```javascript
// sandbox-agent/src/lib/git.js
import { execSync } from 'node:child_process'

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim()
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
  try {
    run(`git commit -m "${message.replace(/"/g, '\\"')}"`, projectDir)
  } catch {
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

- [ ] **Step 2: Commit**

```bash
git add sandbox-agent/src/lib/git.js
git commit -m "feat(sandbox-agent): git operations (init, commit, push)"
```

---

### Task 6: Project routes (CRUD + files + build + push)

**Files:**
- Modify: `sandbox-agent/src/routes/projects.js`
- Test: `sandbox-agent/tests/projects.test.js`

- [ ] **Step 1: Write failing test for project creation**

```javascript
// sandbox-agent/tests/projects.test.js
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Test scaffold-only logic (no Docker/nginx in unit tests)
import { generateScaffold } from '../src/lib/scaffold.js'

describe('project creation flow', () => {
  let tmpDir

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('scaffold creates full project structure', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'))
    const projectDir = path.join(tmpDir, 'juan-perez', 'dashboard')

    generateScaffold(projectDir, {
      name: 'dashboard',
      title: 'Dashboard de Ventas',
      userSlug: 'juan-perez',
    })

    // Verify all files exist
    const files = ['package.json', 'vite.config.js', 'Dockerfile', '.dockerignore', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/App.css']
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(projectDir, f)), `Missing: ${f}`)
    }

    // Verify package.json is valid JSON
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'))
    assert.strictEqual(pkg.name, 'dashboard')
  })
})
```

- [ ] **Step 2: Run test to verify it passes** (uses already-built scaffold)

Run: `cd sandbox-agent && node --test tests/projects.test.js`
Expected: PASS

- [ ] **Step 3: Implement full project routes**

```javascript
// sandbox-agent/src/routes/projects.js
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { generateScaffold } from '../lib/scaffold.js'
import { buildImage, runContainer, stopContainer, getUsedPorts, findFreePort, containerName, imageName, getContainerStatus, execInContainer } from '../lib/docker.js'
import { writeAndReloadNginx } from '../lib/nginx.js'
import { gitInit, gitCommitAndPush } from '../lib/git.js'

const PROJECTS_DIR = process.env.PROJECTS_DIR || '/projects'
const NGINX_CONFIG_PATH = process.env.NGINX_CONFIG_PATH || '/etc/nginx/conf.d/sandbox-projects.conf'
const PORT_START = parseInt(process.env.PORT_RANGE_START || '4001')
const PORT_END = parseInt(process.env.PORT_RANGE_END || '4100')

export const projectsRouter = Router()

// Helper: get all running projects for nginx config
function getRunningProjects() {
  const projects = []
  if (!fs.existsSync(PROJECTS_DIR)) return projects

  for (const userDir of fs.readdirSync(PROJECTS_DIR)) {
    const userPath = path.join(PROJECTS_DIR, userDir)
    if (!fs.statSync(userPath).isDirectory()) continue
    for (const projDir of fs.readdirSync(userPath)) {
      const metaPath = path.join(userPath, projDir, '.sandbox-meta.json')
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        if (meta.port) {
          projects.push({ userSlug: userDir, name: projDir, port: meta.port })
        }
      }
    }
  }
  return projects
}

// POST /projects - Create project
projectsRouter.post('/', async (req, res) => {
  try {
    const { userSlug, name, title, repoUrl } = req.body
    if (!userSlug || !name || !title) {
      return res.status(400).json({ error: 'userSlug, name y title son requeridos' })
    }

    const projectDir = path.join(PROJECTS_DIR, userSlug, name)
    if (fs.existsSync(projectDir)) {
      return res.status(409).json({ error: 'El proyecto ya existe' })
    }

    // 1. Scaffold
    generateScaffold(projectDir, { name, title, userSlug })

    // 2. Git init
    gitInit(projectDir, repoUrl)

    // 3. Find free port
    const usedPorts = await getUsedPorts()
    const port = findFreePort(usedPorts, PORT_START, PORT_END)

    // 4. Save metadata
    const meta = { name, title, userSlug, port, repoUrl, createdAt: new Date().toISOString() }
    fs.writeFileSync(path.join(projectDir, '.sandbox-meta.json'), JSON.stringify(meta, null, 2))

    // 5. Docker build + run
    const imgTag = imageName(userSlug, name)
    await buildImage(projectDir, imgTag)
    await runContainer(containerName(userSlug, name), imgTag, port)

    // 6. Update nginx
    writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())

    // 7. Initial git push
    gitCommitAndPush(projectDir, 'Initial scaffold')

    res.json({ ok: true, port, previewUrl: `/${userSlug}/${name}/` })
  } catch (err) {
    console.error('Create project error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /projects - List all projects
projectsRouter.get('/', (req, res) => {
  const projects = []
  if (!fs.existsSync(PROJECTS_DIR)) return res.json(projects)

  for (const userDir of fs.readdirSync(PROJECTS_DIR)) {
    const userPath = path.join(PROJECTS_DIR, userDir)
    if (!fs.statSync(userPath).isDirectory()) continue
    for (const projDir of fs.readdirSync(userPath)) {
      const metaPath = path.join(userPath, projDir, '.sandbox-meta.json')
      if (fs.existsSync(metaPath)) {
        projects.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')))
      }
    }
  }
  res.json(projects)
})

// GET /projects/:user/:name - Project info
projectsRouter.get('/:user/:name', async (req, res) => {
  const { user, name } = req.params
  const metaPath = path.join(PROJECTS_DIR, user, name, '.sandbox-meta.json')
  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  const status = await getContainerStatus(containerName(user, name))
  res.json({ ...meta, status })
})

// DELETE /projects/:user/:name - Delete project
projectsRouter.delete('/:user/:name', async (req, res) => {
  const { user, name } = req.params
  const projectDir = path.join(PROJECTS_DIR, user, name)
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }
  await stopContainer(containerName(user, name))
  fs.rmSync(projectDir, { recursive: true, force: true })
  writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())
  res.json({ ok: true })
})

// POST /projects/:user/:name/files - Write file
projectsRouter.post('/:user/:name/files', (req, res) => {
  const { user, name } = req.params
  const { path: filePath, content } = req.body
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'path y content son requeridos' })
  }
  const projectDir = path.join(PROJECTS_DIR, user, name)
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath)
  if (!resolved.startsWith(projectDir)) {
    return res.status(400).json({ error: 'Path invalido' })
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content)
  res.json({ ok: true, path: filePath })
})

// GET /projects/:user/:name/files/*path - Read file
projectsRouter.get('/:user/:name/files/*filePath', (req, res) => {
  const { user, name } = req.params
  const filePath = req.params.filePath
  const projectDir = path.join(PROJECTS_DIR, user, name)
  const resolved = path.resolve(projectDir, filePath)

  if (!resolved.startsWith(projectDir) || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Archivo no encontrado' })
  }
  const content = fs.readFileSync(resolved, 'utf-8')
  res.json({ path: filePath, content })
})

// GET /projects/:user/:name/tree - File tree
projectsRouter.get('/:user/:name/tree', (req, res) => {
  const { user, name } = req.params
  const projectDir = path.join(PROJECTS_DIR, user, name)
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }

  function walk(dir, prefix = '') {
    const entries = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push({ path: rel, type: 'dir' })
        entries.push(...walk(path.join(dir, entry.name), rel))
      } else {
        entries.push({ path: rel, type: 'file' })
      }
    }
    return entries
  }

  res.json(walk(projectDir))
})

// POST /projects/:user/:name/build - Rebuild container
projectsRouter.post('/:user/:name/build', async (req, res) => {
  try {
    const { user, name } = req.params
    const projectDir = path.join(PROJECTS_DIR, user, name)
    const metaPath = path.join(projectDir, '.sandbox-meta.json')
    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Proyecto no encontrado' })
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    const imgTag = imageName(user, name)
    await buildImage(projectDir, imgTag)
    await runContainer(containerName(user, name), imgTag, meta.port)
    writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())

    res.json({ ok: true, port: meta.port })
  } catch (err) {
    console.error('Build error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /projects/:user/:name/stop - Stop container
projectsRouter.post('/:user/:name/stop', async (req, res) => {
  const { user, name } = req.params
  await stopContainer(containerName(user, name))
  writeAndReloadNginx(NGINX_CONFIG_PATH, getRunningProjects())
  res.json({ ok: true })
})

// POST /projects/:user/:name/push - Git push
projectsRouter.post('/:user/:name/push', (req, res) => {
  const { user, name } = req.params
  const { message = 'Update from Allaria Hub' } = req.body
  const projectDir = path.join(PROJECTS_DIR, user, name)
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }
  const result = gitCommitAndPush(projectDir, message)
  res.json(result)
})

// POST /projects/:user/:name/exec - Execute command in container
projectsRouter.post('/:user/:name/exec', async (req, res) => {
  try {
    const { user, name } = req.params
    const { cmd } = req.body
    if (!cmd) return res.status(400).json({ error: 'cmd es requerido' })
    const output = await execInContainer(containerName(user, name), cmd)
    res.json({ output })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Run all tests**

Run: `cd sandbox-agent && node --test tests/`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add sandbox-agent/src/routes/projects.js sandbox-agent/tests/projects.test.js
git commit -m "feat(sandbox-agent): project routes (CRUD, files, build, push)"
```

---

### Task 7: Sandbox Agent Dockerfile + docker-compose

**Files:**
- Create: `sandbox-agent/Dockerfile`
- Create: `sandbox-agent/docker-compose.yml`

- [ ] **Step 1: Create Dockerfile for Sandbox Agent**

```dockerfile
# sandbox-agent/Dockerfile
FROM node:20-alpine

RUN apk add --no-cache git docker-cli nginx

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src/ ./src/

EXPOSE 3100

CMD ["node", "src/index.js"]
```

- [ ] **Step 2: Create docker-compose.yml**

```yaml
# sandbox-agent/docker-compose.yml
version: '3.8'

services:
  sandbox-agent:
    build: .
    container_name: sandbox-agent
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /projects:/projects
      - /etc/nginx/conf.d:/etc/nginx/conf.d
    env_file: .env
    environment:
      - PROJECTS_DIR=/projects
      - NGINX_CONFIG_PATH=/etc/nginx/conf.d/sandbox-projects.conf

  nginx-proxy:
    image: nginx:alpine
    container_name: sandbox-nginx
    restart: unless-stopped
    ports:
      - "3099:3099"
    volumes:
      - /etc/nginx/conf.d:/etc/nginx/conf.d:ro
    depends_on:
      - sandbox-agent
```

- [ ] **Step 3: Commit**

```bash
git add sandbox-agent/Dockerfile sandbox-agent/docker-compose.yml
git commit -m "feat(sandbox-agent): Dockerfile + docker-compose"
```

---

## Fase 2: Allaria Hub Backend

### Task 8: Prisma schema — Project model

**Files:**
- Modify: `back/prisma/schema.prisma`

- [ ] **Step 1: Add Project model to schema**

Add to `back/prisma/schema.prisma` after the `UserConnection` model:

```prisma
model Project {
  id          String   @id @default(cuid())
  name        String            // "dashboard-ventas" (slug)
  title       String            // "Dashboard de Ventas"
  description String?
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  gitlabId    Int?              // ID del repo en GitLab
  repoUrl     String?           // URL del repo
  port        Int?              // Puerto asignado
  status      String   @default("creating") // creating, running, stopped, error
  previewUrl  String?           // URL completa de preview
  template    String   @default("vite-react")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
}
```

Add `projects Project[]` to the `User` model (after `connections UserConnection[]`).

- [ ] **Step 2: Run migration**

Run: `cd back && npx prisma migrate dev --name add-project-model`
Expected: Migration created and applied

- [ ] **Step 3: Commit**

```bash
cd back && git add prisma/
git commit -m "feat(back): add Project model to Prisma schema"
```

---

### Task 9: GitLab API client

**Files:**
- Create: `back/src/lib/gitlab.js`

- [ ] **Step 1: Implement GitLab client**

```javascript
// back/src/lib/gitlab.js
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'
const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_GROUP_ID = process.env.GITLAB_GROUP_ID || '54'

async function gitlabApi(path, options = {}) {
  const res = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': GITLAB_TOKEN,
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || JSON.stringify(data))
  return data
}

export async function createGitlabRepo(userSlug, projectName) {
  const repoName = `${userSlug}-${projectName}`
  const data = await gitlabApi('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      namespace_id: parseInt(GITLAB_GROUP_ID),
      visibility: 'internal',
      initialize_with_readme: false,
    }),
  })
  return {
    gitlabId: data.id,
    repoUrl: data.http_url_to_repo,
    webUrl: data.web_url,
  }
}

export async function deleteGitlabRepo(gitlabId) {
  await gitlabApi(`/projects/${gitlabId}`, { method: 'DELETE' })
}
```

- [ ] **Step 2: Commit**

```bash
git add back/src/lib/gitlab.js
git commit -m "feat(back): GitLab API client for repo management"
```

---

### Task 10: Sandbox HTTP client

**Files:**
- Create: `back/src/lib/sandbox-client.js`

- [ ] **Step 1: Implement sandbox client**

```javascript
// back/src/lib/sandbox-client.js
const SANDBOX_AGENT_URL = process.env.SANDBOX_AGENT_URL || 'http://172.30.200.101:3100'
const SANDBOX_AGENT_KEY = process.env.SANDBOX_AGENT_KEY

async function sandboxRequest(path, options = {}) {
  const res = await fetch(`${SANDBOX_AGENT_URL}${path}`, {
    ...options,
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
git add back/src/lib/sandbox-client.js
git commit -m "feat(back): sandbox agent HTTP client"
```

---

### Task 11: Sandbox tool definitions + execution

**Files:**
- Create: `back/src/lib/sandbox-tools.js`
- Modify: `back/src/lib/tools.js`

- [ ] **Step 1: Create sandbox tool definitions**

```javascript
// back/src/lib/sandbox-tools.js
import { prisma } from './prisma.js'
import { createGitlabRepo } from './gitlab.js'
import {
  sandboxCreateProject, sandboxWriteFile, sandboxReadFile,
  sandboxListFiles, sandboxBuild, sandboxPush, sandboxStatus,
} from './sandbox-client.js'

const PREVIEW_BASE = process.env.SANDBOX_PREVIEW_URL || 'https://proyectos-sandbox.allaria.xyz:3099'

function userSlugFromEmail(email) {
  // juan.perez@allaria.com -> juan-perez
  const local = email.split('@')[0]
  return local.replace(/\./g, '-').toLowerCase()
}

export const SANDBOX_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'sandbox_create_project',
      description: 'Crea un nuevo proyecto web con Vite+React. Genera scaffold, buildea container Docker y deploya preview. Confirmá nombre y titulo con el usuario antes de crear.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre slug del proyecto (ej: "dashboard-ventas"). Solo letras minusculas, numeros y guiones.' },
          title: { type: 'string', description: 'Titulo legible del proyecto (ej: "Dashboard de Ventas")' },
          description: { type: 'string', description: 'Descripcion opcional del proyecto' },
        },
        required: ['name', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_write_file',
      description: 'Escribe o sobreescribe un archivo en el proyecto. Usa esto para crear o modificar archivos de codigo.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          filePath: { type: 'string', description: 'Path relativo del archivo (ej: "src/App.jsx")' },
          content: { type: 'string', description: 'Contenido completo del archivo' },
        },
        required: ['projectName', 'filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_read_file',
      description: 'Lee el contenido de un archivo del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          filePath: { type: 'string', description: 'Path relativo del archivo' },
        },
        required: ['projectName', 'filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_list_files',
      description: 'Lista la estructura de archivos del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_build',
      description: 'Reconstruye el container Docker y deploya los cambios. Llama esto despues de modificar archivos para que el usuario vea los cambios en la preview.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_push',
      description: 'Commitea y pushea los cambios a GitLab. Confirmá con el usuario antes de pushear.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
          message: { type: 'string', description: 'Mensaje del commit' },
        },
        required: ['projectName', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_status',
      description: 'Devuelve el estado del proyecto (running/stopped, URL de preview, puerto, etc.).',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Nombre slug del proyecto' },
        },
        required: ['projectName'],
      },
    },
  },
]

export async function executeSandboxTool(name, args, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('Usuario no encontrado')
  const userSlug = userSlugFromEmail(user.email)

  switch (name) {
    case 'sandbox_create_project': {
      // 1. Crear repo en GitLab
      const { gitlabId, repoUrl, webUrl } = await createGitlabRepo(userSlug, args.name)

      // 2. Crear en DB
      const project = await prisma.project.create({
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

      // 3. Crear en Sandbox Agent
      const result = await sandboxCreateProject(userSlug, args.name, args.title, repoUrl)

      // 4. Actualizar DB
      const previewUrl = `${PREVIEW_BASE}/${userSlug}/${args.name}/`
      await prisma.project.update({
        where: { id: project.id },
        data: {
          port: result.port,
          previewUrl,
          status: 'running',
        },
      })

      return {
        message: `Proyecto "${args.title}" creado exitosamente.`,
        previewUrl,
        repoUrl: webUrl,
        status: 'running',
      }
    }

    case 'sandbox_write_file': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      await sandboxWriteFile(userSlug, args.projectName, args.filePath, args.content)
      return { ok: true, message: `Archivo ${args.filePath} escrito.` }
    }

    case 'sandbox_read_file': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      return await sandboxReadFile(userSlug, args.projectName, args.filePath)
    }

    case 'sandbox_list_files': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      return await sandboxListFiles(userSlug, args.projectName)
    }

    case 'sandbox_build': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      await sandboxBuild(userSlug, args.projectName)
      await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
      return { ok: true, message: 'Build completado. Preview actualizada.', previewUrl: project.previewUrl }
    }

    case 'sandbox_push': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      const result = await sandboxPush(userSlug, args.projectName, args.message)
      return { ...result, repoUrl: project.repoUrl }
    }

    case 'sandbox_status': {
      const project = await prisma.project.findFirst({ where: { userId, name: args.projectName } })
      if (!project) throw new Error(`Proyecto "${args.projectName}" no encontrado`)
      const agentStatus = await sandboxStatus(userSlug, args.projectName)
      return {
        name: project.name,
        title: project.title,
        status: agentStatus.status,
        previewUrl: project.previewUrl,
        repoUrl: project.repoUrl,
        port: project.port,
      }
    }

    default:
      throw new Error(`Tool sandbox desconocida: ${name}`)
  }
}
```

- [ ] **Step 2: Modify tools.js to register sandbox tools**

In `back/src/lib/tools.js`:

Add import at the top:
```javascript
import { SANDBOX_TOOL_DEFINITIONS, executeSandboxTool } from './sandbox-tools.js'
```

Add to `CONFIRMABLE_TOOLS`:
```javascript
export const CONFIRMABLE_TOOLS = new Set([
  'gmail_send',
  'calendar_create',
  'tasks_create',
  'tasks_complete',
  'sandbox_create_project',
  'sandbox_push',
])
```

Add to `TOOL_DEFINITIONS`:
```javascript
  sandbox: SANDBOX_TOOL_DEFINITIONS,
```

Add sandbox cases to `executeTool` switch (before the `default` case):
```javascript
    // Sandbox
    case 'sandbox_create_project':
    case 'sandbox_write_file':
    case 'sandbox_read_file':
    case 'sandbox_list_files':
    case 'sandbox_build':
    case 'sandbox_push':
    case 'sandbox_status':
      return await executeSandboxTool(name, args, userId)
```

- [ ] **Step 3: Commit**

```bash
git add back/src/lib/sandbox-tools.js back/src/lib/tools.js
git commit -m "feat(back): sandbox tool definitions + execution"
```

---

### Task 12: Projects REST API route

**Files:**
- Create: `back/src/routes/projects.js`
- Modify: `back/src/index.js`

- [ ] **Step 1: Create projects route**

```javascript
// back/src/routes/projects.js
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { sandboxDelete, sandboxStop } from '../lib/sandbox-client.js'
import { deleteGitlabRepo } from '../lib/gitlab.js'

export const projectsRouter = Router()

function userSlugFromEmail(email) {
  const local = email.split('@')[0]
  return local.replace(/\./g, '-').toLowerCase()
}

// GET /api/projects - List user's projects
projectsRouter.get('/', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
  })
  res.json(projects)
})

// GET /api/projects/:id - Get project detail
projectsRouter.get('/:id', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })
  res.json(project)
})

// DELETE /api/projects/:id - Delete project
projectsRouter.delete('/:id', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

  const userSlug = userSlugFromEmail(req.user.email)

  // Stop and delete from sandbox agent
  try { await sandboxDelete(userSlug, project.name) } catch {}

  // Delete GitLab repo
  if (project.gitlabId) {
    try { await deleteGitlabRepo(project.gitlabId) } catch {}
  }

  // Delete from DB
  await prisma.project.delete({ where: { id: project.id } })
  res.json({ ok: true })
})

// POST /api/projects/:id/stop - Stop project container
projectsRouter.post('/:id/stop', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

  const userSlug = userSlugFromEmail(req.user.email)
  await sandboxStop(userSlug, project.name)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'stopped' } })
  res.json({ ok: true })
})
```

- [ ] **Step 2: Register route in index.js**

In `back/src/index.js`, add import:
```javascript
import { projectsRouter } from './routes/projects.js'
```

Add route (after the `/api/chat` line):
```javascript
app.use('/api/projects', authenticate, projectsRouter)
```

- [ ] **Step 3: Commit**

```bash
git add back/src/routes/projects.js back/src/index.js
git commit -m "feat(back): projects REST API route"
```

---

## Fase 3: Frontend

### Task 13: API client + ConnectorPicker sandbox entry

**Files:**
- Modify: `front/src/lib/api.js`
- Modify: `front/src/components/ConnectorPicker.jsx`

- [ ] **Step 1: Add project endpoints to api.js**

Add to the `api` object in `front/src/lib/api.js`:

```javascript
  // Projects
  getProjects: () => request('/api/projects'),

  getProject: (id) => request(`/api/projects/${id}`),

  deleteProject: (id) =>
    request(`/api/projects/${id}`, { method: 'DELETE' }),

  stopProject: (id) =>
    request(`/api/projects/${id}/stop`, { method: 'POST' }),
```

- [ ] **Step 2: Add sandbox to ConnectorPicker CONNECTORS array**

In `front/src/components/ConnectorPicker.jsx`, add to the `CONNECTORS` array:

```javascript
  {
    id: 'sandbox',
    name: 'Sandbox',
    logo: 'https://www.google.com/s2/favicons?sz=64&domain=docker.com',
    color: '#2496ED',
    desc: 'Crear y editar proyectos web',
    noOAuth: true, // No necesita OAuth, siempre disponible
  },
```

Modify `isConnected` to treat sandbox as always connected:
```javascript
  const isConnected = (id) => id === 'sandbox' || connections.some(c => c.provider === id)
```

In the connector item rendering, skip "Conectar"/"Desconectar" for sandbox — just show the toggle:

Replace the `connector-item-actions` div content. In the ternary for `!connected`, add a check for `conn.noOAuth`:

```jsx
{loading === conn.id ? (
  <div className="connector-item-loading">
    <Loader2 size={16} className="connector-spin" />
  </div>
) : !connected ? (
  <button
    className="connector-btn-connect"
    onClick={() => handleConnect(conn)}
  >
    Conectar
  </button>
) : (
  <>
    <button
      className={`connector-toggle ${active ? 'on' : ''}`}
      onClick={() => onToggle(conn.id)}
      title={active ? 'Desactivar' : 'Activar'}
    >
      <div className="connector-toggle-track">
        <div className="connector-toggle-thumb" />
      </div>
    </button>
    {!conn.noOAuth && (
      <button
        className="connector-btn-disconnect"
        onClick={() => handleDisconnect(conn.id)}
        title="Desconectar cuenta"
      >
        Desconectar
      </button>
    )}
  </>
)}
```

- [ ] **Step 3: Commit**

```bash
git add front/src/lib/api.js front/src/components/ConnectorPicker.jsx
git commit -m "feat(front): sandbox connector in picker + project API endpoints"
```

---

### Task 14: Chat.jsx sandbox integration

**Files:**
- Modify: `front/src/pages/Chat.jsx`

- [ ] **Step 1: Add sandbox to TOOL_ICONS and TOOL_LABELS**

In `front/src/pages/Chat.jsx`, add imports (add `Code` and `GitBranch` to the lucide import):

```javascript
import { ..., Code, GitBranch } from 'lucide-react'
```

Add to `TOOL_ICONS`:
```javascript
  sandbox_create_project: Code,
  sandbox_push: GitBranch,
```

Add to `TOOL_LABELS`:
```javascript
  sandbox_create_project: 'Crear proyecto',
  sandbox_push: 'Push a GitLab',
```

- [ ] **Step 2: Add sandbox system prompt**

In the `systemMsg` content array inside `sendMessage`, add:

```javascript
activeConnectors.includes('sandbox') && 'Tenes acceso al sandbox de proyectos. Podes crear proyectos web con Vite+React, escribir archivos, buildear y deployar previews. Cuando crees o modifiques archivos, hacelo directamente con las tools. Despues de modificar archivos, siempre llama sandbox_build para que el usuario vea los cambios.',
```

- [ ] **Step 3: Add ConfirmationCard rendering for sandbox tools**

In the `ConfirmationCard` component, add:

```jsx
{toolName === 'sandbox_create_project' && (
  <>
    <div className="confirmation-field"><strong>Proyecto:</strong> {args.name}</div>
    <div className="confirmation-field"><strong>Titulo:</strong> {args.title}</div>
    {args.description && <div className="confirmation-field">{args.description}</div>}
  </>
)}
{toolName === 'sandbox_push' && (
  <>
    <div className="confirmation-field"><strong>Proyecto:</strong> {args.projectName}</div>
    <div className="confirmation-field"><strong>Commit:</strong> {args.message}</div>
  </>
)}
```

- [ ] **Step 4: Commit**

```bash
git add front/src/pages/Chat.jsx
git commit -m "feat(front): sandbox tools in chat (icons, labels, system prompt, confirmations)"
```

---

### Task 15: Projects page

**Files:**
- Create: `front/src/pages/Projects.jsx`
- Create: `front/src/pages/Projects.css`
- Modify: `front/src/App.jsx` (add route)

- [ ] **Step 1: Create Projects page**

```jsx
// front/src/pages/Projects.jsx
import { useState, useEffect } from 'react'
import { ExternalLink, Trash2, GitBranch, Square, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import './Projects.css'

const STATUS_COLORS = {
  running: '#22c55e',
  stopped: '#ef4444',
  creating: '#eab308',
  error: '#ef4444',
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id) => {
    if (!confirm('Eliminar este proyecto? Se borrara el container, el repo y los archivos.')) return
    try {
      await api.deleteProject(id)
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleStop = async (id) => {
    try {
      await api.stopProject(id)
      setProjects(prev => prev.map(p =>
        p.id === id ? { ...p, status: 'stopped' } : p
      ))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  if (loading) {
    return (
      <div className="projects-page">
        <div className="projects-loading">
          <Loader2 size={24} className="spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="projects-page">
      <div className="projects-header">
        <h1>Mis Proyectos</h1>
        <p>Proyectos creados desde el chat con Sandbox</p>
      </div>

      {projects.length === 0 ? (
        <div className="projects-empty">
          <p>No tenes proyectos todavia.</p>
          <p>Activa el conector <strong>Sandbox</strong> en el chat y pedi que te cree uno.</p>
          <button className="btn btn-primary" onClick={() => navigate('/chat')}>
            Ir al Chat
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map(project => (
            <div key={project.id} className="project-card">
              <div className="project-card-header">
                <h3>{project.title}</h3>
                <span
                  className="project-status-badge"
                  style={{ '--status-color': STATUS_COLORS[project.status] || '#888' }}
                >
                  {project.status}
                </span>
              </div>

              {project.description && (
                <p className="project-card-desc">{project.description}</p>
              )}

              <div className="project-card-meta">
                <span className="project-card-slug">{project.name}</span>
                <span className="project-card-template">{project.template}</span>
              </div>

              <div className="project-card-actions">
                {project.previewUrl && (
                  <a
                    href={project.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="project-btn preview"
                  >
                    <ExternalLink size={14} />
                    Preview
                  </a>
                )}
                {project.repoUrl && (
                  <a
                    href={project.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="project-btn repo"
                  >
                    <GitBranch size={14} />
                    GitLab
                  </a>
                )}
                {project.status === 'running' && (
                  <button
                    className="project-btn stop"
                    onClick={() => handleStop(project.id)}
                  >
                    <Square size={14} />
                    Detener
                  </button>
                )}
                <button
                  className="project-btn delete"
                  onClick={() => handleDelete(project.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create Projects.css**

```css
/* front/src/pages/Projects.css */
.projects-page {
  max-width: 1000px;
  margin: 0 auto;
  padding: 2rem;
}

.projects-loading {
  display: flex;
  justify-content: center;
  padding: 4rem;
}

.projects-header {
  margin-bottom: 2rem;
}

.projects-header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: #fafafa;
  margin-bottom: 0.25rem;
}

.projects-header p {
  color: #888;
  font-size: 0.9rem;
}

.projects-empty {
  text-align: center;
  padding: 4rem 2rem;
  color: #888;
}

.projects-empty p {
  margin-bottom: 0.5rem;
}

.projects-empty .btn {
  margin-top: 1rem;
}

.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.project-card {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.project-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.project-card-header h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #fafafa;
}

.project-status-badge {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  color: var(--status-color);
  background: color-mix(in srgb, var(--status-color) 15%, transparent);
}

.project-card-desc {
  color: #888;
  font-size: 0.85rem;
  line-height: 1.4;
}

.project-card-meta {
  display: flex;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.project-card-slug {
  color: #667eea;
  font-family: monospace;
  background: rgba(102, 126, 234, 0.1);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.project-card-template {
  color: #888;
  background: #222;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.project-card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: 0.5rem;
  border-top: 1px solid #2a2a2a;
}

.project-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid #333;
  background: transparent;
  color: #ccc;
  text-decoration: none;
  transition: all 0.15s;
}

.project-btn:hover {
  background: #222;
  color: #fafafa;
}

.project-btn.preview {
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.3);
}

.project-btn.repo {
  color: #f97316;
  border-color: rgba(249, 115, 22, 0.3);
}

.project-btn.stop {
  color: #eab308;
  border-color: rgba(234, 179, 8, 0.3);
}

.project-btn.delete {
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
  margin-left: auto;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: Add route in App.jsx**

In `front/src/App.jsx`, add import:
```javascript
import Projects from './pages/Projects'
```

Add route (alongside the existing routes):
```jsx
<Route path="/projects" element={<Projects />} />
```

- [ ] **Step 4: Commit**

```bash
git add front/src/pages/Projects.jsx front/src/pages/Projects.css front/src/App.jsx
git commit -m "feat(front): Projects page with grid view"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Crear proyecto desde chat (Task 11: `sandbox_create_project` tool)
- [x] Modificar archivos (Task 11: `sandbox_write_file` tool)
- [x] Preview en vivo (Tasks 4, 6: nginx + docker)
- [x] Push a GitLab (Tasks 5, 9, 11: git, gitlab client, tool)
- [x] Ver estado (Task 11: `sandbox_status` tool)
- [x] Template Vite+React (Task 2: scaffold)
- [x] Sandbox Agent endpoints (Tasks 1-7)
- [x] Prisma model (Task 8)
- [x] ConnectorPicker (Task 13)
- [x] Projects page (Task 15)
- [x] Chat system prompt (Task 14)
- [x] Confirmable tools (Task 11: create + push)
- [x] Auth shared secret (Task 1)
- [x] Port pool 4001-4100 (Task 3)
- [x] Path traversal protection (Task 6)
- [x] Env vars documented (Tasks 1, 9, 10)

**Type consistency:**
- `userSlug` / `userSlugFromEmail` — consistent across sandbox-tools.js and projects.js
- `containerName` / `imageName` — consistent in docker.js and projects router
- Tool names: `sandbox_*` — consistent across definitions, execution, CONFIRMABLE_TOOLS, TOOL_ICONS, TOOL_LABELS

**No placeholders found.**
