import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { createSessionPod, waitForPodReady, deleteSessionPod } from '../lib/k8s.js'
import { subscribe, unsubscribe, getSnapshot } from '../lib/active-streams.js'

export const sessionsRouter = Router({ mergeParams: true })

const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.allaria.xyz'

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  // Usar IP directa + HTTP para evitar ELB→nginx que no tiene vhost de GitLab
  const path = url.replace(/https?:\/\/gitlab\.allaria\.xyz/, '')
  const base = path.endsWith('.git') ? path : path + '.git'
  return `http://oauth2:${GITLAB_TOKEN}@172.30.200.101${base}`
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

    try {
      session = await prisma.session.create({
        data: { id: sessionId, userId, projectId, podName, status: 'starting' },
      })
    } catch (dbErr) {
      // Rollback: delete the pod to avoid resource leak
      deleteSessionPod(podName).catch(() => {})
      throw dbErr
    }

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

// GET /api/projects/:id/active-stream — SSE de reconexión a un stream en curso
sessionsRouter.get('/active-stream', async (req, res) => {
  try {
    const { id: projectId } = req.params
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: req.user.id },
    })
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })
    if (!project.chatId) return res.status(404).json({ error: 'Proyecto sin chat asociado' })

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const chatId = project.chatId
    const snapshot = getSnapshot(chatId)

    if (!snapshot) {
      res.write(`data: ${JSON.stringify({ type: 'no_active_stream' })}\n\n`)
      res.end()
      return
    }

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch {}
    }, 15000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe(chatId, res)
    })

    subscribe(chatId, res)
  } catch (err) {
    console.error('[active-stream] error:', err.message)
    try { res.end() } catch {}
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
