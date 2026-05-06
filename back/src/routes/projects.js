import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { sandboxDelete, sandboxStop } from '../lib/sandbox-client.js'
import { sandboxCreateProject } from '../lib/sandbox-client.js'
import { createGitlabRepo, deleteGitlabRepo } from '../lib/gitlab.js'

export const projectsRouter = Router()

function userSlugFromEmail(email) {
  const local = email.split('@')[0]
  return local.replace(/\./g, '-').toLowerCase()
}

// POST /api/projects - Crear proyecto directamente (sin LLM)
projectsRouter.post('/', async (req, res) => {
  try {
    const { name, title, description } = req.body
    if (!name || !title) {
      return res.status(400).json({ error: 'name y title son requeridos' })
    }

    // Validar slug
    if (!/^[a-z0-9-]+$/.test(name)) {
      return res.status(400).json({ error: 'name solo puede tener letras minusculas, numeros y guiones' })
    }

    const userSlug = userSlugFromEmail(req.user.email)

    // Verificar que no exista
    const existing = await prisma.project.findFirst({ where: { userId: req.user.id, name } })
    if (existing) return res.status(409).json({ error: 'Ya existe un proyecto con ese nombre' })

    // 1. Crear repo en GitLab
    let gitlabId = null, repoUrl = null, gitHttpUrl = null
    try {
      const gitlab = await createGitlabRepo(userSlug, name)
      gitlabId = gitlab.gitlabId
      repoUrl = gitlab.webUrl
      gitHttpUrl = gitlab.repoUrl
    } catch (err) {
      console.warn('GitLab error (continuando sin repo):', err.message)
    }

    // 2. Crear en DB
    const project = await prisma.project.create({
      data: { name, title, description: description || null, userId: req.user.id, gitlabId, repoUrl, status: 'creating', template: 'vite-react' },
    })

    // 3. Crear chat dedicado
    const chat = await prisma.chat.create({
      data: { title: `🚧 ${title}`, userId: req.user.id },
    })

    const PREVIEW_BASE = process.env.SANDBOX_PREVIEW_URL || 'https://proyectos-sandbox.allaria.xyz'
    const previewUrl = `${PREVIEW_BASE}/${userSlug}/${name}/`

    // 4. Llamar al sandbox agent (ahora devuelve inmediatamente con status: building)
    let port = null
    try {
      const result = await sandboxCreateProject(userSlug, name, title, gitHttpUrl)
      port = result.port
    } catch (err) {
      console.error('Sandbox agent error:', err.message)
      await prisma.project.update({ where: { id: project.id }, data: { chatId: chat.id, status: 'error' } })
      return res.status(502).json({ error: `Error al iniciar el sandbox: ${err.message}` })
    }

    // 5. Actualizar DB con port y chatId — status queda en 'creating' hasta que el build termine
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { chatId: chat.id, port, previewUrl, status: 'creating' },
    })

    // 6. Responder al frontend inmediatamente
    res.json(updated)

    // 7. Polling en background: esperar a que el sandbox confirme que está running
    ;(async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 6000))
        try {
          const status = await sandboxStatus(userSlug, name)
          if (status.status === 'running') {
            await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
            console.log(`[projects] ${name} build completado → running`)
            return
          }
          if (status.status === 'error') {
            await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
            return
          }
        } catch {}
      }
      // Timeout: marcar como error
      await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } }).catch(() => {})
      console.error(`[projects] ${name} build timeout`)
    })()
  } catch (err) {
    console.error('Create project error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/projects/community - All public projects ordered by stars
projectsRouter.get('/community', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { isPublic: true, status: 'running' },
    orderBy: { stars: { _count: 'desc' } },
    include: {
      user: { select: { id: true, name: true, picture: true } },
      _count: { select: { stars: true } },
    },
  })

  const starred = await prisma.projectStar.findMany({
    where: { userId: req.user.id, projectId: { in: projects.map(p => p.id) } },
    select: { projectId: true },
  })
  const starredSet = new Set(starred.map(s => s.projectId))

  res.json(projects.map(p => ({
    ...p,
    starredByMe: starredSet.has(p.id),
  })))
})

// GET /api/projects - List user's projects
projectsRouter.get('/', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { stars: true } } },
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

// GET /api/projects/:id/chat - Get or create dedicated chat for project
projectsRouter.get('/:id/chat', async (req, res) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    })
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

    let chat
    if (project.chatId) {
      chat = await prisma.chat.findUnique({ where: { id: project.chatId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
    }

    if (!chat) {
      chat = await prisma.chat.create({
        data: { title: `🚧 ${project.title}`, userId: req.user.id },
        include: { messages: true },
      })
      await prisma.project.update({ where: { id: project.id }, data: { chatId: chat.id } })
    }

    res.json(chat)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/projects/:id - Update project title/description
projectsRouter.patch('/:id', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

  const { title, description } = req.body
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { ...(title && { title }), ...(description !== undefined && { description }) },
  })
  res.json(updated)
})

// DELETE /api/projects/:id - Delete project
projectsRouter.delete('/:id', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

  const userSlug = userSlugFromEmail(req.user.email)
  try { await sandboxDelete(userSlug, project.name) } catch {}
  if (project.gitlabId) {
    try { await deleteGitlabRepo(project.gitlabId) } catch {}
  }
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
