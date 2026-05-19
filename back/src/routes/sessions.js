import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { createSessionPod, waitForPodReady, deleteSessionPod } from '../lib/k8s.js'

export const sessionsRouter = Router({ mergeParams: true })

const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  const base = url.endsWith('.git') ? url : url + '.git'
  return base.replace(/https:\/\/gitlab\.allaria\.xyz/, `http://oauth2:${GITLAB_TOKEN}@gitlab.allaria.xyz`)
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
