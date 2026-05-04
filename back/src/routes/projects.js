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
