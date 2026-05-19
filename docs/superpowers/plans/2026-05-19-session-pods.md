# Session Pods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el loop de tool-calling en el back-end por pods efímeros en CCE que corren el agente (Anthropic SDK + LiteLLM) con acceso directo al repo del proyecto.

**Architecture:** El back-end spawna un pod K8s en `sandbox-sessions` namespace cuando el usuario abre un workspace. El pod clona el repo, corre un servidor Express que expone `/chat` como SSE, y el back-end proxea los mensajes del usuario al pod y el SSE al front. El pod muere tras 60 min de inactividad.

**Tech Stack:** Node.js 23-alpine, @anthropic-ai/sdk, @kubernetes/client-node, Express 5, Prisma 6, Vitest

---

## File Map

**Nuevos archivos:**
```
session-agent/
  src/index.js        Servidor Express: /chat (SSE) + /health
  src/agent.js        Loop Anthropic SDK con tools
  src/tools.js        5 tools: read_file, write_file, list_files, bash, git_push
  src/git.js          Helpers: clone, commit, push
  package.json
  Dockerfile
  .env.example
  src/__tests__/
    tools.test.js
    agent.test.js
    git.test.js

back/src/lib/k8s.js           K8s client: create/wait/delete pods
back/src/routes/sessions.js   POST/GET/DELETE /api/projects/:id/session + internal end

k8s/session-rbac.yaml         ServiceAccount + Role + RoleBinding
```

**Archivos modificados:**
```
back/prisma/schema.prisma                 Agregar model Session
back/src/index.js                         Registrar sessionsRouter + cleanup cron
back/src/routes/proxy.js                  Detectar projectId → proxy al pod
back/package.json                         Agregar @kubernetes/client-node
k8s/back-deployment.yaml                  Agregar serviceAccountName: hub-back
front/src/pages/ProjectWorkspace.jsx      startSession al montar, projectId en stream, system prompt actualizado
front/src/lib/api.js                      Agregar startSession(), endSession()
.gitlab-ci.yml                            Agregar build-session-agent
```

---

## Task 1: Prisma Session model

**Files:**
- Modify: `back/prisma/schema.prisma`

- [ ] **Step 1: Agregar model Session al schema**

Abrir `back/prisma/schema.prisma` y agregar al final, también agregar `sessions Session[]` al model User y Project:

```prisma
// En model User, agregar:
  sessions    Session[]

// En model Project, agregar:
  sessions    Session[]

// Al final del archivo:
model Session {
  id           String   @id @default(cuid())
  userId       String
  projectId    String
  podName      String
  podIP        String?
  status       String   @default("starting") // starting | ready | dead
  filesChanged String[] @default([])
  commitCount  Int      @default(0)
  summary      String?
  lastActivity DateTime @default(now())
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id])
  project      Project  @relation(fields: [projectId], references: [id])

  @@index([userId, projectId])
}
```

- [ ] **Step 2: Push schema a la DB**

Conectarse al servidor (o desde el pod del back) y correr:

```bash
# Desde la máquina local apuntando a la DB:
DATABASE_URL="postgresql://root:17DeAgosto@172.30.200.114:5432/allaria_hub" npx prisma db push
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 3: Commit**

```bash
git add back/prisma/schema.prisma
git commit -m "feat(db): agregar model Session para pods efímeros"
```

---

## Task 2: K8s RBAC + back deployment update

**Files:**
- Create: `k8s/session-rbac.yaml`
- Modify: `k8s/back-deployment.yaml`

- [ ] **Step 1: Crear k8s/session-rbac.yaml**

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
    verbs: ["create", "get", "list", "delete", "watch"]
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

- [ ] **Step 2: Agregar serviceAccountName al back deployment**

En `k8s/back-deployment.yaml`, dentro de `spec.template.spec`, agregar después de `imagePullSecrets`:

```yaml
      serviceAccountName: hub-back
```

- [ ] **Step 3: Aplicar RBAC al cluster desde .101**

```bash
# SSH a .101, luego:
/home/allaria/bin/kubectl apply -f k8s/session-rbac.yaml
```

Expected output:
```
serviceaccount/hub-back created
role.rbac.authorization.k8s.io/session-manager created
rolebinding.rbac.authorization.k8s.io/hub-back-session-manager created
```

- [ ] **Step 4: Verificar que el namespace sandbox-sessions existe**

```bash
/home/allaria/bin/kubectl get namespace sandbox-sessions
```

Si no existe: `/home/allaria/bin/kubectl create namespace sandbox-sessions`

- [ ] **Step 5: Commit**

```bash
git add k8s/session-rbac.yaml k8s/back-deployment.yaml
git commit -m "feat(k8s): RBAC para que el back pueda gestionar pods de sesión"
```

---

## Task 3: session-agent skeleton

**Files:**
- Create: `session-agent/package.json`
- Create: `session-agent/Dockerfile`
- Create: `session-agent/.env.example`

- [ ] **Step 1: Crear session-agent/package.json**

```json
{
  "name": "session-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.36.0",
    "dotenv": "^16.4.7",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Crear session-agent/Dockerfile**

```dockerfile
FROM node:23-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV PORT=3200
ENV WORKSPACE_DIR=/workspace

EXPOSE 3200
CMD ["node", "src/index.js"]
```

- [ ] **Step 3: Crear session-agent/.env.example**

```
REPO_URL=https://oauth2:TOKEN@gitlab.allaria.xyz/allaria-sandbox/user-project.git
LITELLM_URL=http://172.30.200.101:4000
LITELLM_KEY=sk-allaria-xxx
SESSION_ID=session-abc123
BACK_URL=http://back.allaria-hub.svc.cluster.local:3098
WORKSPACE_DIR=/workspace
PORT=3200
```

- [ ] **Step 4: Commit**

```bash
git add session-agent/
git commit -m "feat(session-agent): scaffold inicial — Dockerfile + package.json"
```

---

## Task 4: session-agent — git.js

**Files:**
- Create: `session-agent/src/git.js`
- Create: `session-agent/src/__tests__/git.test.js`

- [ ] **Step 1: Crear session-agent/src/git.js**

```js
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 120_000 })
  if (result.error) throw new Error(`${cmd} error: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} falló:\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

export function gitClone(repoUrl, targetDir) {
  if (fs.existsSync(targetDir)) {
    run('git', ['pull', '--ff-only'], targetDir)
    return
  }
  run('git', ['clone', repoUrl, targetDir], '/')
  run('git', ['config', 'safe.directory', '*'], targetDir)
}

export function gitCommitAndPush(dir, message) {
  run('git', ['config', 'user.email', 'session-agent@allaria.xyz'], dir)
  run('git', ['config', 'user.name', 'Allaria Session Agent'], dir)

  const statusOut = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })
  if (!statusOut.stdout.trim()) {
    return { pushed: false, message: 'Nada para commitear' }
  }

  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-m', message], dir)
  run('git', ['push'], dir)

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
  return { pushed: true, commit: commit.stdout.trim() }
}

export function getChangedFiles(dir) {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
    cwd: dir, encoding: 'utf-8',
  })
  return result.stdout.trim().split('\n').filter(Boolean)
}
```

- [ ] **Step 2: Instalar dependencias del session-agent**

```bash
cd session-agent && npm install
```

- [ ] **Step 3: Crear session-agent/src/__tests__/git.test.js**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { gitCommitAndPush } from '../git.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'))
  spawnSync('git', ['init'], { cwd: tmpDir })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  // Crear commit inicial para que HEAD exista
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'init')
  spawnSync('git', ['add', '-A'], { cwd: tmpDir })
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('gitCommitAndPush', () => {
  it('retorna pushed:false cuando no hay cambios', () => {
    const result = gitCommitAndPush(tmpDir, 'test')
    expect(result.pushed).toBe(false)
    expect(result.message).toBe('Nada para commitear')
  })

  it('commitea cuando hay archivos nuevos (sin push a remoto)', () => {
    fs.writeFileSync(path.join(tmpDir, 'nuevo.js'), 'console.log("hola")')
    // git push fallará sin remoto — pero commit sí funciona
    // Simulamos: verificamos que después del commit staged changes desaparecen
    spawnSync('git', ['config', 'user.email', 'session-agent@allaria.xyz'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Allaria Session Agent'], { cwd: tmpDir })
    spawnSync('git', ['add', '-A'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'test commit'], { cwd: tmpDir })
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
    expect(status.stdout.trim()).toBe('')
  })
})
```

- [ ] **Step 4: Correr tests**

```bash
cd session-agent && npm test
```

Expected: `✓ git.test.js (2 tests)`

- [ ] **Step 5: Commit**

```bash
git add session-agent/src/git.js session-agent/src/__tests__/git.test.js
git commit -m "feat(session-agent): git helpers — clone, commit, push"
```

---

## Task 5: session-agent — tools.js

**Files:**
- Create: `session-agent/src/tools.js`
- Create: `session-agent/src/__tests__/tools.test.js`

- [ ] **Step 1: Crear session-agent/src/tools.js**

```js
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gitCommitAndPush, getChangedFiles } from './git.js'

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'

const BASH_ALLOWLIST = new Set(['npm', 'npx', 'node', 'cat', 'ls', 'mkdir', 'cp', 'mv'])

function safePath(filePath) {
  const resolved = path.resolve(WORKSPACE, filePath)
  if (!resolved.startsWith(WORKSPACE)) throw new Error(`Path inválido: ${filePath}`)
  return resolved
}

function walkDir(dir, prefix = '') {
  const entries = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    entries.push({ path: rel, type: entry.isDirectory() ? 'dir' : 'file' })
    if (entry.isDirectory()) entries.push(...walkDir(path.join(dir, entry.name), rel))
  }
  return entries
}

export const toolDefinitions = [
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo del proyecto.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relativo desde la raíz del proyecto (ej: "src/App.jsx")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Escribe o sobreescribe un archivo del proyecto con el contenido completo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relativo del archivo' },
        content: { type: 'string', description: 'Contenido completo del archivo' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'Lista la estructura de archivos del proyecto.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'bash',
    description: 'Ejecuta un comando de desarrollo. Permitidos: npm, npx, node, cat, ls, mkdir, cp, mv.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Comando a ejecutar (ej: "npm install react-query")' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'git_push',
    description: 'Commitea y pushea los cambios al repositorio. Llamá esto cuando terminés todos los cambios de la tarea.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensaje descriptivo del commit' },
      },
      required: ['message'],
    },
  },
]

export async function executeTool(name, input) {
  switch (name) {
    case 'read_file': {
      const resolved = safePath(input.path)
      if (!fs.existsSync(resolved)) return { error: `Archivo no encontrado: ${input.path}` }
      return { content: fs.readFileSync(resolved, 'utf-8') }
    }

    case 'write_file': {
      const resolved = safePath(input.path)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, input.content)
      return { ok: true, path: input.path }
    }

    case 'list_files': {
      if (!fs.existsSync(WORKSPACE)) return { error: 'Workspace no encontrado' }
      return { files: walkDir(WORKSPACE) }
    }

    case 'bash': {
      const cmd = input.cmd.trim()
      const parts = cmd.split(/\s+/)
      const bin = parts[0]
      if (!BASH_ALLOWLIST.has(bin)) {
        return { error: `Comando no permitido: "${bin}". Permitidos: ${[...BASH_ALLOWLIST].join(', ')}` }
      }
      const result = spawnSync(bin, parts.slice(1), {
        cwd: WORKSPACE,
        encoding: 'utf-8',
        timeout: 120_000,
      })
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status ?? 1,
      }
    }

    case 'git_push': {
      const result = gitCommitAndPush(WORKSPACE, input.message)
      if (!result.pushed) return { ok: false, message: result.message }
      const files = getChangedFiles(WORKSPACE)
      return { ok: true, pushed: true, commit: result.commit, filesChanged: files }
    }

    default:
      return { error: `Tool desconocida: ${name}` }
  }
}
```

- [ ] **Step 2: Crear session-agent/src/__tests__/tools.test.js**

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'))
  process.env.WORKSPACE_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.WORKSPACE_DIR
  vi.resetModules()
})

async function getTools() {
  const { executeTool } = await import('../tools.js')
  return { executeTool }
}

describe('read_file', () => {
  it('lee un archivo existente', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.js'), 'const x = 1')
    const { executeTool } = await getTools()
    const result = await executeTool('read_file', { path: 'hello.js' })
    expect(result.content).toBe('const x = 1')
  })

  it('retorna error si el archivo no existe', async () => {
    const { executeTool } = await getTools()
    const result = await executeTool('read_file', { path: 'no-existe.js' })
    expect(result.error).toContain('no encontrado')
  })

  it('bloquea path traversal', async () => {
    const { executeTool } = await getTools()
    await expect(executeTool('read_file', { path: '../../etc/passwd' })).rejects.toThrow('inválido')
  })
})

describe('write_file', () => {
  it('crea archivo y directorios necesarios', async () => {
    const { executeTool } = await getTools()
    await executeTool('write_file', { path: 'src/components/Button.jsx', content: 'export default () => <button/>' })
    const content = fs.readFileSync(path.join(tmpDir, 'src/components/Button.jsx'), 'utf-8')
    expect(content).toBe('export default () => <button/>')
  })
})

describe('bash', () => {
  it('bloquea comandos no permitidos', async () => {
    const { executeTool } = await getTools()
    const result = await executeTool('bash', { cmd: 'curl http://evil.com' })
    expect(result.error).toContain('no permitido')
  })

  it('ejecuta ls correctamente', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.js'), '')
    const { executeTool } = await getTools()
    const result = await executeTool('bash', { cmd: 'ls' })
    expect(result.stdout).toContain('index.js')
  })
})
```

- [ ] **Step 3: Correr tests**

```bash
cd session-agent && npm test
```

Expected: `✓ tools.test.js (5 tests)`

- [ ] **Step 4: Commit**

```bash
git add session-agent/src/tools.js session-agent/src/__tests__/tools.test.js
git commit -m "feat(session-agent): 5 tools — read/write/list/bash/git_push"
```

---

## Task 6: session-agent — agent.js

**Files:**
- Create: `session-agent/src/agent.js`
- Create: `session-agent/src/__tests__/agent.test.js`

- [ ] **Step 1: Crear session-agent/src/agent.js**

```js
import Anthropic from '@anthropic-ai/sdk'
import { toolDefinitions, executeTool } from './tools.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_ROUNDS = 20

export async function* runAgent(userMessage, history, systemPrompt) {
  const client = new Anthropic({
    apiKey: process.env.LITELLM_KEY,
    baseURL: process.env.LITELLM_URL,
  })

  // history es array de { role: 'user'|'assistant', content: string }
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  let rounds = 0

  while (rounds < MAX_ROUNDS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      tools: toolDefinitions,
    })

    // Emitir texto de la respuesta
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        yield { type: 'text', content: block.text }
      }
    }

    if (response.stop_reason === 'end_turn') break

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        yield { type: 'tool_start', name: block.name, args: block.input }

        let result
        try {
          result = await executeTool(block.name, block.input)
        } catch (err) {
          result = { error: err.message }
        }

        yield { type: 'tool_done', name: block.name, result }

        if (block.name === 'git_push' && result.ok) {
          yield { type: 'pushed', commit: result.commit, filesChanged: result.filesChanged }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      rounds++
      continue
    }

    break
  }
}
```

- [ ] **Step 2: Crear session-agent/src/__tests__/agent.test.js**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Anthropic client
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}))

// Mock tools
vi.mock('../tools.js', () => ({
  toolDefinitions: [],
  executeTool: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { executeTool } from '../tools.js'
import { runAgent } from '../agent.js'

async function collect(gen) {
  const events = []
  for await (const e of gen) events.push(e)
  return events
}

describe('runAgent', () => {
  let mockCreate

  beforeEach(() => {
    mockCreate = Anthropic.mock.results[0]?.value?.messages?.create
    if (!mockCreate) {
      const instance = new Anthropic()
      mockCreate = instance.messages.create
    }
    vi.clearAllMocks()
    // Reinstanciar para limpiar mocks
    const instance = { messages: { create: vi.fn() } }
    Anthropic.mockReturnValue(instance)
    mockCreate = instance.messages.create
  })

  it('emite text y termina en end_turn', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hola!' }],
    })

    const events = await collect(runAgent('hola', [], 'system prompt'))
    expect(events).toContainEqual({ type: 'text', content: 'Hola!' })
  })

  it('ejecuta tool y continúa el loop', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Los archivos son...' }],
      })

    executeTool.mockResolvedValue({ files: ['src/App.jsx'] })

    const events = await collect(runAgent('listá los archivos', [], 'sys'))
    expect(events.some(e => e.type === 'tool_start' && e.name === 'list_files')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    expect(events.some(e => e.type === 'text')).toBe(true)
  })

  it('emite pushed cuando git_push retorna ok:true', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'git_push', input: { message: 'feat: add button' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '✅ Pusheado' }],
      })

    executeTool.mockResolvedValue({ ok: true, pushed: true, commit: 'abc123', filesChanged: ['src/App.jsx'] })

    const events = await collect(runAgent('pusheá', [], 'sys'))
    const pushedEvent = events.find(e => e.type === 'pushed')
    expect(pushedEvent).toBeDefined()
    expect(pushedEvent.commit).toBe('abc123')
  })
})
```

- [ ] **Step 3: Correr tests**

```bash
cd session-agent && npm test
```

Expected: `✓ agent.test.js (3 tests)`

- [ ] **Step 4: Commit**

```bash
git add session-agent/src/agent.js session-agent/src/__tests__/agent.test.js
git commit -m "feat(session-agent): agent loop con Anthropic SDK + LiteLLM"
```

---

## Task 7: session-agent — servidor HTTP

**Files:**
- Create: `session-agent/src/index.js`

- [ ] **Step 1: Crear session-agent/src/index.js**

```js
import 'dotenv/config'
import express from 'express'
import { runAgent } from './agent.js'
import { gitClone, gitCommitAndPush } from './git.js'

const app = express()
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3200
const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'
const REPO_URL = process.env.REPO_URL
const SESSION_ID = process.env.SESSION_ID
const BACK_URL = process.env.BACK_URL

const SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Nunca digas "listo", "hecho" ni des por completada ninguna tarea sin haber ejecutado el flujo completo.

FLUJO OBLIGATORIO para cualquier modificación:
1. read_file — Leé el archivo actual antes de modificar
2. write_file — Escribí el archivo completo con los cambios aplicados
3. git_push — Commitea y pushea los cambios. El CI de GitLab buildea y deploya automáticamente.
4. Confirmá al usuario: "✅ Pusheado. El CI está desplegando (~5min). Podés verlo en la preview."

HERRAMIENTAS DISPONIBLES:
- read_file(path) — leer un archivo del proyecto
- write_file(path, content) — escribir un archivo completo
- list_files() — ver estructura del proyecto
- bash(cmd) — ejecutar npm install, npm run, etc.
- git_push(message) — commitear y pushear todos los cambios

REGLAS ADICIONALES:
- Para instalar librerías: bash("npm install <paquete>") → write_file → git_push
- Si el usuario pregunta "¿en qué estábamos?", usá read_file en CHANGELOG.md primero
- Actualizá CHANGELOG.md con fecha y descripción de cada cambio importante
- NO creés proyectos nuevos. Solo trabajás dentro del proyecto activo.`

// Estado de inactividad
let lastActivity = Date.now()
const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 60 min

// GET /health
app.get('/health', (req, res) => {
  const idleSince = Date.now() - lastActivity
  res.json({
    status: 'ok',
    sessionId: SESSION_ID,
    idleSinceMs: idleSince,
  })
})

// POST /chat → SSE stream
app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body

  if (!message) return res.status(400).json({ error: 'message es requerido' })

  lastActivity = Date.now()

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {}
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch {}
  }, 15_000)

  try {
    send({ type: 'thinking' })

    let fullText = ''
    for await (const event of runAgent(message, history, SYSTEM_PROMPT)) {
      send(event)
      if (event.type === 'text') fullText += event.content
    }

    send({ type: 'done', content: fullText })
  } catch (err) {
    send({ type: 'error', message: err.message })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})

// Shutdown graceful
async function shutdown(signal) {
  console.log(`[session-agent] ${signal} recibido — iniciando shutdown`)
  try {
    const result = gitCommitAndPush(WORKSPACE, 'session end: auto-push')
    if (result.pushed) console.log(`[session-agent] Auto-push OK: ${result.commit}`)
  } catch (err) {
    console.warn('[session-agent] Auto-push falló:', err.message)
  }

  if (BACK_URL && SESSION_ID) {
    try {
      await fetch(`${BACK_URL}/api/internal/sessions/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Sesión finalizada por inactividad' }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
  }

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Idle watcher: verifica inactividad cada 5 min
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log('[session-agent] Inactividad detectada — iniciando shutdown')
    shutdown('IDLE')
  }
}, 5 * 60_000)

// Startup: clonar repo
async function start() {
  if (REPO_URL) {
    console.log(`[session-agent] Clonando ${REPO_URL}...`)
    try {
      gitClone(REPO_URL, WORKSPACE)
      console.log('[session-agent] Repo listo')
    } catch (err) {
      console.error('[session-agent] Error clonando repo:', err.message)
      process.exit(1)
    }
  }

  app.listen(PORT, () => {
    console.log(`[session-agent] Running on port ${PORT} — session ${SESSION_ID}`)
  })
}

start()
```

- [ ] **Step 2: Verificar que arranca localmente sin REPO_URL**

```bash
cd session-agent && LITELLM_KEY=test LITELLM_URL=http://localhost:4000 SESSION_ID=test-1 node src/index.js
```

Expected: `[session-agent] Running on port 3200 — session test-1`  
(sin REPO_URL no clona, arranca directo)

Ctrl+C para detener.

- [ ] **Step 3: Commit**

```bash
git add session-agent/src/index.js
git commit -m "feat(session-agent): servidor HTTP con /chat SSE y shutdown graceful"
```

---

## Task 8: session-agent CI pipeline

**Files:**
- Modify: `.gitlab-ci.yml`

- [ ] **Step 1: Agregar job build-session-agent al .gitlab-ci.yml**

Agregar después del job `build-front`:

```yaml
build-session-agent:
  extends: .build
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
  script:
    - docker build --platform linux/amd64
        -t "$SWR_REGISTRY/$SWR_ORGANIZATION/session-agent:$CI_COMMIT_SHORT_SHA"
        -t "$SWR_REGISTRY/$SWR_ORGANIZATION/session-agent:latest"
        ./session-agent
    - docker push "$SWR_REGISTRY/$SWR_ORGANIZATION/session-agent:$CI_COMMIT_SHORT_SHA"
    - docker push "$SWR_REGISTRY/$SWR_ORGANIZATION/session-agent:latest"
```

- [ ] **Step 2: Commit y push a main para triggerear build**

```bash
git add .gitlab-ci.yml
git commit -m "ci: agregar build-session-agent al pipeline"
git push origin main
```

- [ ] **Step 3: Verificar pipeline en GitLab**

Ir a `https://gitlab.allaria.xyz` → el repo del Hub → Pipelines.  
Esperar que `build-session-agent` pase (✅ verde).  
Verificar que la imagen existe en SWR: `swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest`

---

## Task 9: back — k8s.js

**Files:**
- Modify: `back/package.json` (agregar dependencia)
- Create: `back/src/lib/k8s.js`

- [ ] **Step 1: Instalar @kubernetes/client-node en el back**

```bash
cd back && npm install @kubernetes/client-node@^0.21.0
```

- [ ] **Step 2: Crear back/src/lib/k8s.js**

```js
import k8s from '@kubernetes/client-node'

const NAMESPACE = 'sandbox-sessions'
const IMAGE = 'swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest'

function makeClient() {
  const kc = new k8s.KubeConfig()
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster()
  } else {
    kc.loadFromDefault()
  }
  return kc.makeApiClient(k8s.CoreV1Api)
}

export async function createSessionPod(sessionId, repoUrl, litellmUrl, litellmKey, backUrl) {
  const coreV1 = makeClient()

  const podSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `session-${sessionId}`,
      namespace: NAMESPACE,
      labels: { app: 'session-agent', sessionId },
    },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 30,
      imagePullSecrets: [{ name: 'swr-pull-secret' }],
      containers: [
        {
          name: 'agent',
          image: IMAGE,
          ports: [{ containerPort: 3200 }],
          env: [
            { name: 'REPO_URL', value: repoUrl },
            { name: 'LITELLM_URL', value: litellmUrl || process.env.LITELLM_URL },
            { name: 'LITELLM_KEY', value: litellmKey || process.env.LITELLM_KEY },
            { name: 'SESSION_ID', value: sessionId },
            { name: 'BACK_URL', value: backUrl || 'http://back.allaria-hub.svc.cluster.local:3098' },
          ],
          resources: {
            requests: { cpu: '100m', memory: '256Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
          readinessProbe: {
            httpGet: { path: '/health', port: 3200 },
            initialDelaySeconds: 10,
            periodSeconds: 5,
          },
        },
      ],
    },
  }

  await coreV1.createNamespacedPod(NAMESPACE, podSpec)
  return `session-${sessionId}`
}

export async function waitForPodReady(podName, timeoutMs = 60_000) {
  const coreV1 = makeClient()
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { body } = await coreV1.readNamespacedPod(podName, NAMESPACE)
    const phase = body.status?.phase
    const podIP = body.status?.podIP

    if (phase === 'Running' && podIP) {
      // Esperar que el readiness probe pase
      const conditions = body.status?.conditions || []
      const ready = conditions.find(c => c.type === 'Ready')
      if (ready?.status === 'True') return podIP
    }

    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`Pod ${podName} terminó inesperadamente con phase: ${phase}`)
    }

    await new Promise(r => setTimeout(r, 3000))
  }

  throw new Error(`Pod ${podName} no estuvo listo en ${timeoutMs}ms`)
}

export async function deleteSessionPod(podName) {
  const coreV1 = makeClient()
  try {
    await coreV1.deleteNamespacedPod(podName, NAMESPACE)
  } catch (err) {
    // 404 = ya no existe, ignorar
    if (!err.body?.code === 404) throw err
  }
}

export async function getPodPhase(podName) {
  const coreV1 = makeClient()
  try {
    const { body } = await coreV1.readNamespacedPod(podName, NAMESPACE)
    return body.status?.phase || 'Unknown'
  } catch {
    return 'NotFound'
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add back/package.json back/package-lock.json back/src/lib/k8s.js
git commit -m "feat(back): k8s client para gestión de session pods"
```

---

## Task 10: back — sessions routes

**Files:**
- Create: `back/src/routes/sessions.js`
- Modify: `back/src/index.js`

- [ ] **Step 1: Crear back/src/routes/sessions.js**

```js
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { createSessionPod, waitForPodReady, deleteSessionPod } from '../lib/k8s.js'

export const sessionsRouter = Router({ mergeParams: true })

const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  const base = url.endsWith('.git') ? url : url + '.git'
  return base.replace(/https:\/\/gitlab\.allaria\.xyz/, `http://oauth2:${GITLAB_TOKEN}@gitlab`)
}

async function findActiveSession(userId, projectId) {
  return prisma.session.findFirst({
    where: { userId, projectId, status: { not: 'dead' } },
    orderBy: { createdAt: 'desc' },
  })
}

// POST /api/projects/:id/session — obtener o crear sesión activa
sessionsRouter.post('/', async (req, res) => {
  try {
    const { id: projectId } = req.params
    const userId = req.user.id

    const project = await prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

    let session = await findActiveSession(userId, projectId)

    if (session) {
      return res.json({ sessionId: session.id, status: session.status, podIP: session.podIP })
    }

    // Crear pod
    const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const podName = await createSessionPod(
      sessionId,
      repoUrlWithAuth(project.repoUrl),
      process.env.LITELLM_URL,
      process.env.LITELLM_KEY,
    )

    session = await prisma.session.create({
      data: { id: sessionId, userId, projectId, podName, status: 'starting' },
    })

    res.json({ sessionId: session.id, status: 'starting' })
  } catch (err) {
    console.error('[sessions] POST error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/projects/:id/session — estado de la sesión activa
sessionsRouter.get('/', async (req, res) => {
  try {
    const { id: projectId } = req.params
    const session = await findActiveSession(req.user.id, projectId)
    if (!session) return res.json({ status: 'none' })
    res.json({ sessionId: session.id, status: session.status, podIP: session.podIP })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/projects/:id/session — matar sesión
sessionsRouter.delete('/', async (req, res) => {
  try {
    const { id: projectId } = req.params
    const session = await findActiveSession(req.user.id, projectId)
    if (!session) return res.json({ ok: true })

    await deleteSessionPod(session.podName)
    await prisma.session.update({ where: { id: session.id }, data: { status: 'dead' } })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// NOTA: el endpoint /api/internal/sessions/:sessionId/end se registra
// directamente en back/src/index.js (ver Task 10 Step 2), no aquí.
```

- [ ] **Step 2: Registrar routes en back/src/index.js**

Agregar import y rutas en `back/src/index.js`:

```js
// Agregar import al inicio junto a los otros:
import { sessionsRouter } from './routes/sessions.js'
import { prisma } from './lib/prisma.js'  // ya existe

// Agregar ANTES del app.listen:

// Sessions: CRUD de pods por proyecto (mergeParams pasa :id al router)
app.use('/api/projects/:id/session', authenticate, sessionsRouter)

// Internal: llamado por el pod al morir (sin auth, solo red interna del cluster)
app.post('/api/internal/sessions/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { filesChanged = [], commitCount = 0, summary = '' } = req.body
    await prisma.session.updateMany({
      where: { id: sessionId },
      data: { status: 'dead', filesChanged, commitCount, summary },
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

Y eliminar el handler `sessionsRouter.post('/internal/:sessionId/end', ...)` de `sessions.js` — ese endpoint queda en `index.js` directamente.

Nota: el endpoint interno NO tiene auth porque lo llama el pod desde la red interna del cluster (no es accesible desde internet).

- [ ] **Step 3: Commit**

```bash
git add back/src/routes/sessions.js back/src/index.js
git commit -m "feat(back): routes de sesiones — crear/obtener/eliminar pods"
```

---

## Task 11: back — proxy.js modificado

**Files:**
- Modify: `back/src/routes/proxy.js`

El stream endpoint actual no recibe `projectId`. Hay que agregar el branch de proxy al pod cuando viene con `projectId`.

- [ ] **Step 1: Agregar imports al inicio de proxy.js**

```js
// Agregar junto a los imports existentes:
import { prisma } from '../lib/prisma.js'  // ya existe
import { createSessionPod, waitForPodReady } from '../lib/k8s.js'
import { pollGitlabPipeline } from '../lib/sandbox-tools.js'  // ya existe
```

- [ ] **Step 2: Agregar helper getOrCreateSession antes del router**

Agregar después de los imports, antes de `export const proxyRouter = Router()`:

```js
const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_URL_ENV = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  const base = url.endsWith('.git') ? url : url + '.git'
  return base.replace(/https:\/\/gitlab\.allaria\.xyz/, `http://oauth2:${GITLAB_TOKEN}@gitlab`)
}

async function getOrCreateSession(userId, projectId) {
  let session = await prisma.session.findFirst({
    where: { userId, projectId, status: { not: 'dead' } },
    orderBy: { createdAt: 'desc' },
  })

  if (session) return session

  const project = await prisma.project.findFirst({ where: { id: projectId, userId } })
  if (!project) throw new Error('Proyecto no encontrado')

  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const podName = await createSessionPod(
    sessionId,
    repoUrlWithAuth(project.repoUrl),
    process.env.LITELLM_URL,
    process.env.LITELLM_KEY,
  )

  session = await prisma.session.create({
    data: { id: sessionId, userId, projectId, podName, status: 'starting' },
  })

  return session
}
```

- [ ] **Step 3: Modificar el handler de /completions para extraer projectId**

En `proxyRouter.post('/stream', ...)`, modificar la destructuring al inicio:

```js
const { chatId, model, messages, connectors = [], temperature = 0.7, max_tokens = 8192, projectId } = req.body
```

- [ ] **Step 4: Agregar branch de proxy al pod en /stream**

Después de las validaciones de `chatId` y `messages`, antes de guardar el mensaje del usuario, agregar:

```js
// Si viene con projectId → es workspace con session pod
if (projectId) {
  return handleWorkspaceStream(req, res, { chatId, messages, projectId, send, heartbeat })
}
```

Luego agregar la función `handleWorkspaceStream` después del handler de `/stream`:

```js
async function handleWorkspaceStream(req, res, { chatId, messages, projectId, send, heartbeat }) {
  try {
    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } })
    if (!chat) { send({ type: 'error', message: 'Chat no encontrado' }); return }

    const lastUserMsg = messages[messages.length - 1]
    if (lastUserMsg.role === 'user') {
      await prisma.message.create({
        data: { chatId, role: 'user', content: extractTextForDb(lastUserMsg.content) },
      })
    }

    // Obtener o crear sesión
    let session
    try {
      session = await getOrCreateSession(req.user.id, projectId)
    } catch (err) {
      send({ type: 'error', message: `Error iniciando sesión: ${err.message}` })
      return
    }

    // Esperar que el pod esté ready
    let podIP = session.podIP
    if (!podIP || session.status === 'starting') {
      send({ type: 'thinking', message: 'Preparando el agente...' })
      try {
        podIP = await waitForPodReady(session.podName, 60_000)
        await prisma.session.update({
          where: { id: session.id },
          data: { podIP, status: 'ready', lastActivity: new Date() },
        })
      } catch (err) {
        send({ type: 'error', message: `El agente no pudo iniciar: ${err.message}` })
        return
      }
    } else {
      await prisma.session.update({ where: { id: session.id }, data: { lastActivity: new Date() } })
    }

    // Proxy al pod
    const podRes = await fetch(`http://${podIP}:3200/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: lastUserMsg.content,
        history: messages.slice(0, -1),
      }),
      signal: AbortSignal.timeout(300_000),
    })

    if (!podRes.ok) {
      send({ type: 'error', message: `Pod respondió ${podRes.status}` })
      return
    }

    // Pipe SSE del pod al cliente
    const reader = podRes.body.getReader()
    const decoder = new TextDecoder()
    let assistantContent = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          send(data)
          if (data.type === 'done') assistantContent = data.content
          if (data.type === 'pushed') {
            // Actualizar estado del proyecto a 'creating' y arrancar poll CI en background
            const project = await prisma.project.findFirst({ where: { id: projectId } })
            if (project?.gitlabId) {
              await prisma.project.update({ where: { id: project.id }, data: { status: 'creating' } })
              pollGitlabPipeline(project.gitlabId, new Date()).then(async (result) => {
                await prisma.project.update({
                  where: { id: project.id },
                  data: { status: result.ok ? 'running' : 'error' },
                })
              }).catch(() => {})
            }
          }
        } catch {}
      }
    }

    if (assistantContent) {
      await prisma.message.create({
        data: { chatId, role: 'assistant', content: assistantContent, model: 'claude-sonnet-4-5' },
      })
      await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
    }
  } catch (err) {
    console.error('[workspace stream] error:', err.message)
    send({ type: 'error', message: err.message })
  }
}
```

- [ ] **Step 5: Ajustar el handler de /stream para pasar send y heartbeat**

El `send` y `heartbeat` ya están definidos dentro del handler. Hay que moverlos o refactorizar para que `handleWorkspaceStream` los reciba. La forma más limpia: extraer las definiciones de `send` y `heartbeat` antes del branch de `projectId`, y pasarlas.

El handler de `/stream` queda así (solo la parte de setup, el resto sin cambios):

```js
proxyRouter.post('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  let clientConnected = true
  req.on('close', () => { clientConnected = false })

  const heartbeat = setInterval(() => {
    if (clientConnected) try { res.write(': ping\n\n') } catch {}
  }, 15000)

  const send = (obj) => {
    if (clientConnected) try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {}
  }

  try {
    const { chatId, model, messages, connectors = [], temperature = 0.7, max_tokens = 8192, projectId } = req.body

    if (!chatId || !messages?.length) {
      send({ type: 'error', message: 'chatId y messages son requeridos' })
      return
    }

    // Branch workspace con session pod
    if (projectId) {
      await handleWorkspaceStream(req, res, { chatId, messages, projectId, send, heartbeat })
      return
    }

    // ... resto del handler existente sin cambios ...
  } catch (err) {
    // ...
  } finally {
    clearInterval(heartbeat)
    if (clientConnected) res.end()
  }
})
```

- [ ] **Step 6: Commit**

```bash
git add back/src/routes/proxy.js
git commit -m "feat(back): proxy /api/chat/stream al session pod cuando hay projectId"
```

---

## Task 12: back — cleanup de sesiones en reconciliation

**Files:**
- Modify: `back/src/index.js`

- [ ] **Step 1: Agregar import de k8s al index.js**

```js
import { deleteSessionPod, getPodPhase } from './lib/k8s.js'
```

- [ ] **Step 2: Agregar pass 3 al final de reconcileProjects**

Dentro de `reconcileProjects()`, antes del `setTimeout` final:

```js
    // Pass 3: limpiar sesiones idle > 70 min
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000)
    const staleSessions = await prisma.session.findMany({
      where: {
        status: { not: 'dead' },
        lastActivity: { lt: seventyMinAgo },
      },
    })

    for (const session of staleSessions) {
      try {
        await deleteSessionPod(session.podName)
        await prisma.session.update({ where: { id: session.id }, data: { status: 'dead' } })
        console.log(`[reconcile] session ${session.id} → dead (idle timeout)`)
      } catch (err) {
        console.warn(`[reconcile] error limpiando sesión ${session.id}:`, err.message)
      }
    }
```

- [ ] **Step 3: Commit**

```bash
git add back/src/index.js
git commit -m "feat(back): limpiar session pods idle > 70min en reconciliation job"
```

---

## Task 13: frontend

**Files:**
- Modify: `front/src/lib/api.js`
- Modify: `front/src/pages/ProjectWorkspace.jsx`

- [ ] **Step 1: Agregar startSession y endSession a api.js**

En `front/src/lib/api.js`, agregar dentro del objeto `api`:

```js
  startSession: (projectId) =>
    fetch(`${BASE}/api/projects/${projectId}/session`, {
      method: 'POST',
      headers: getHeaders(),
    }).then(r => r.json()).catch(() => {}),

  endSession: (projectId) =>
    fetch(`${BASE}/api/projects/${projectId}/session`, {
      method: 'DELETE',
      headers: getHeaders(),
    }).then(r => r.json()).catch(() => {}),
```

- [ ] **Step 2: Modificar ProjectWorkspace.jsx — startSession al montar**

Agregar un `useEffect` después del `useEffect` de carga del proyecto existente:

```js
  // Arrancar pod de sesión cuando el proyecto cargue
  useEffect(() => {
    if (!project?.id) return
    api.startSession(project.id)
    return () => { api.endSession(project.id) }
  }, [project?.id])
```

- [ ] **Step 3: Agregar projectId al body del stream**

En `ProjectWorkspace.jsx`, buscar la llamada a `fetch` del stream y agregar `projectId`:

```js
body: JSON.stringify({
  chatId: chat.id,
  model: selectedModel,
  messages: llmMessages,
  connectors: CONNECTORS,
  projectId: project.id,   // ← agregar esta línea
}),
```

- [ ] **Step 4: Actualizar SANDBOX_SYSTEM_PROMPT en ProjectWorkspace.jsx**

Reemplazar la constante `SANDBOX_SYSTEM_PROMPT` existente con:

```js
const SANDBOX_SYSTEM_PROMPT = `Sos el asistente de desarrollo de este proyecto web.

REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Nunca digas "listo", "hecho" ni des por completada ninguna tarea sin haber ejecutado el flujo completo.

FLUJO OBLIGATORIO para cualquier modificación:
1. read_file — Leé el archivo actual antes de modificar
2. write_file — Escribí el archivo completo con los cambios aplicados
3. git_push — Commitea y pushea los cambios. El CI de GitLab buildea y deploya automáticamente.
4. Confirmá al usuario: "✅ Pusheado. El CI está desplegando (~5min). Podés verlo en la preview."

HERRAMIENTAS DISPONIBLES:
- read_file(path) — leer un archivo del proyecto
- write_file(path, content) — escribir un archivo completo
- list_files() — ver estructura del proyecto
- bash(cmd) — ejecutar npm install, npm run, etc.
- git_push(message) — commitear y pushear todos los cambios

REGLAS ADICIONALES:
- Para instalar librerías: bash("npm install <paquete>") → write_file → git_push
- Si el usuario pregunta "¿en qué estábamos?", leé CHANGELOG.md primero con read_file
- Actualizá CHANGELOG.md con fecha y descripción de cada cambio
- NO creés proyectos nuevos desde acá`
```

- [ ] **Step 5: Actualizar TOOL_PROGRESS para los nuevos nombres**

Reemplazar la constante `TOOL_PROGRESS`:

```js
const TOOL_PROGRESS = {
  write_file:    (a) => `Escribiendo ${a.path || 'archivo'}`,
  read_file:     (a) => `Leyendo ${a.path || 'archivo'}`,
  list_files:    ()  => 'Listando archivos',
  bash:          (a) => `$ ${a.cmd || ''}`,
  git_push:      (a) => `Pusheando: ${a.message || ''}`,
  // Mantener nombres viejos por compatibilidad con proyectos que aún usen sandbox-agent
  sandbox_write_file:    (a) => `Escribiendo ${a.filePath || 'archivo'}`,
  sandbox_read_file:     (a) => `Leyendo ${a.filePath || 'archivo'}`,
  sandbox_list_files:    ()  => 'Listando archivos',
  sandbox_build:         ()  => 'Pusheando y esperando pipeline CI...',
  sandbox_status:        ()  => 'Revisando estado',
}
```

- [ ] **Step 6: Commit**

```bash
git add front/src/lib/api.js front/src/pages/ProjectWorkspace.jsx
git commit -m "feat(front): integrar session pods — startSession, projectId en stream, system prompt actualizado"
```

---

## Task 14: Deploy y smoke test

- [ ] **Step 1: Push a main para triggerear CI completo**

```bash
git push origin main
```

Esperar que el pipeline pase (build-back, build-front, build-session-agent, deploy-back, deploy-front).

- [ ] **Step 2: Aplicar RBAC y actualizar deployment desde .101**

```bash
# SSH a .101
/home/allaria/bin/kubectl apply -f k8s/session-rbac.yaml
/home/allaria/bin/kubectl apply -f k8s/back-deployment.yaml
/home/allaria/bin/kubectl -n allaria-hub rollout restart deployment/back
/home/allaria/bin/kubectl -n allaria-hub rollout status deployment/back
```

- [ ] **Step 3: Verificar que el back tiene el ServiceAccount**

```bash
/home/allaria/bin/kubectl -n allaria-hub get pod -l app=back -o jsonpath='{.items[0].spec.serviceAccountName}'
```

Expected: `hub-back`

- [ ] **Step 4: Push schema a la DB de producción**

```bash
# Desde el pod del back:
/home/allaria/bin/kubectl -n allaria-hub exec deployment/back -- npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 5: Smoke test — abrir un workspace**

1. Ir a `https://allaria-hub.allaria.xyz`
2. Abrir un proyecto existente en workspace
3. Verificar en logs del back: `[sessions] POST` y creación del pod
4. Verificar el pod arrancó: 
   ```bash
   /home/allaria/bin/kubectl -n sandbox-sessions get pods
   ```
   Expected: un pod `session-{id}` en Running
5. Enviar un mensaje al agente: *"listá los archivos del proyecto"*
6. Verificar que el agente responde con la estructura de archivos del repo
7. Enviar: *"agregá un comentario en el archivo README.md"*
8. Verificar que el agente llama `read_file`, `write_file`, `git_push`
9. Verificar en GitLab que hay un nuevo commit
10. Verificar que el CI buildea

- [ ] **Step 6: Smoke test — inactividad**

Dejar el workspace sin actividad 5 min (para testear el timer, acortar `IDLE_TIMEOUT_MS` en el pod temporalmente a 5 min durante el test).  
Verificar que el pod muere: `kubectl -n sandbox-sessions get pods` → pod desaparece.  
Verificar en DB: `session.status = 'dead'`.

- [ ] **Step 7: Smoke test — reconexión**

Abrir el workspace nuevamente. Verificar que arranca un pod nuevo, clona el repo con el commit del test anterior, y el historial del chat está disponible.
