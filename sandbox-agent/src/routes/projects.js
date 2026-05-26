// sandbox-agent/src/routes/projects.js
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { generateScaffold } from '../lib/scaffold.js'
import { stopContainer, containerName, getContainerStatus, execInContainer } from '../lib/docker.js'
import { writeAndReloadNginx } from '../lib/nginx.js'
import { gitInit, gitCommitAndPush } from '../lib/git.js'

const PROJECTS_DIR = process.env.PROJECTS_DIR || '/projects'
const NGINX_CONFIG_PATH = process.env.NGINX_CONFIG_PATH || '/etc/nginx/conf.d/sandbox-projects.conf'
const PREVIEW_URL = process.env.PROJECTS_PREVIEW_URL || 'https://proyectos-sandbox.allaria.xyz'
const MAX_CONCURRENT_BUILDS = parseInt(process.env.MAX_CONCURRENT_BUILDS || '3')

// Semáforo para limitar builds concurrentes
let activeBuilds = 0
const buildQueue = []

function acquireBuildSlot() {
  return new Promise((resolve) => {
    if (activeBuilds < MAX_CONCURRENT_BUILDS) {
      activeBuilds++
      resolve()
    } else {
      buildQueue.push(resolve)
    }
  })
}

function releaseBuildSlot() {
  if (buildQueue.length > 0) {
    const next = buildQueue.shift()
    next()
  } else {
    activeBuilds--
  }
}

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

    // 3. Metadata (sin puerto — deploy en CCE)
    const previewUrl = `${PREVIEW_URL}/${userSlug}/${name}/`
    const meta = { name, title, userSlug, repoUrl, status: 'building', previewUrl, createdAt: new Date().toISOString() }
    const metaPath = path.join(projectDir, '.sandbox-meta.json')
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    // 4. Responder inmediatamente — el CI se encarga del build y deploy
    res.json({ ok: true, status: 'building', previewUrl })

    // 5. Git push en background (ligero, no bloquea)
    ;(async () => {
      try {
        const result = gitCommitAndPush(projectDir, 'Initial scaffold', meta.repoUrl)
        if (result.pushed) {
          console.log(`[sandbox] ${userSlug}/${name} pushed OK → CI pipeline en curso`)
        } else {
          console.warn(`[sandbox] ${userSlug}/${name} git push falló:`, result.message)
          try { fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: result.message }, null, 2)) } catch {}
        }
      } catch (err) {
        console.error(`[sandbox] ${userSlug}/${name} create background error:`, err.message)
        try { fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: err.message }, null, 2)) } catch {}
      }
    })()
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
  const liveStatus = await getContainerStatus(containerName(user, name))
  // Si el container ya está corriendo (CI terminó), actualizar meta
  if (meta.status === 'building' && liveStatus === 'running') {
    const updated = { ...meta, status: 'running' }
    try { fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2)) } catch {}
    return res.json(updated)
  }
  res.json({ ...meta, status: liveStatus })
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

// GET /projects/:user/:name/files/*filePath - Read file
projectsRouter.get('/:user/:name/files/*filePath', (req, res) => {
  const { user, name } = req.params
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath
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

const CHECK_HOST = process.env.PROXY_HOST || 'host.docker.internal'

// Verifica que el container responde HTTP 200, reintenta hasta maxAttempts veces
async function waitForContainer(port, maxAttempts = 15, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://${CHECK_HOST}:${port}/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return { ok: true }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs))
  }
  return { ok: false, error: `El container no respondió en /health después de ${maxAttempts} intentos (${maxAttempts * delayMs / 1000}s)` }
}

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

    // Push en background — CI se encarga del build y deploy
    const pushUrl = req.body?.repoUrl || meta.repoUrl
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'building' }, null, 2))
    res.json({ ok: true, status: 'building', previewUrl: meta.previewUrl })

    ;(async () => {
      try {
        const result = gitCommitAndPush(projectDir, 'Update from Allaria Hub', pushUrl)
        if (result.pushed) {
          console.log(`[sandbox] ${user}/${name} pushed OK → CI pipeline en curso`)
        } else if (result.message === 'Nada para commitear') {
          fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'running' }, null, 2))
          console.log(`[sandbox] ${user}/${name} sin cambios, ya estaba running`)
        } else {
          console.error(`[sandbox] ${user}/${name} git push falló:`, result.message)
          try { fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: result.message }, null, 2)) } catch {}
        }
      } catch (err) {
        console.error(`[sandbox] ${user}/${name} build error:`, err.message)
        try { fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'error', error: err.message }, null, 2)) } catch {}
      }
    })()
  } catch (err) {
    console.error('Build error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /projects/:user/:name/stop - Stop container
projectsRouter.post('/:user/:name/stop', async (req, res) => {
  const { user, name } = req.params
  await stopContainer(containerName(user, name))
  res.json({ ok: true })
})

// POST /projects/:user/:name/push - Git push
projectsRouter.post('/:user/:name/push', (req, res) => {
  const { user, name } = req.params
  const { message = 'Update from Allaria Hub', repoUrl } = req.body
  const projectDir = path.join(PROJECTS_DIR, user, name)
  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Proyecto no encontrado' })
  }
  const result = gitCommitAndPush(projectDir, message, repoUrl)
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
