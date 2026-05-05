import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.js'
import { chatRouter } from './routes/chats.js'
import { proxyRouter } from './routes/proxy.js'
import { authenticate } from './middleware/auth.js'
import { connectorRouter } from './routes/connectors.js'
import { projectsRouter } from './routes/projects.js'
import { prisma } from './lib/prisma.js'
import { sandboxStatus } from './lib/sandbox-client.js'

const app = express()
const PORT = process.env.PORT || 3098

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}))
app.use(express.json({ limit: '50mb' }))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Public
app.use('/api/auth', authRouter)

// Connectors: callback is public (Google redirects browser), rest needs auth
app.use('/api/connectors', (req, res, next) => {
  if (req.path === '/callback') return next()
  authenticate(req, res, next)
}, connectorRouter)

// Stats del dashboard
app.get('/api/stats', authenticate, async (req, res) => {
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [activeProjects, totalUsers, chatsThisMonth, totalMessages] = await Promise.all([
    prisma.project.count({ where: { status: 'running' } }),
    prisma.user.count(),
    prisma.chat.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.message.count(),
  ])

  res.json({ activeProjects, totalUsers, chatsThisMonth, totalMessages })
})

// Protected
app.use('/api/chats', authenticate, chatRouter)
app.use('/api/chat', authenticate, proxyRouter)
app.use('/api/projects', authenticate, projectsRouter)

app.listen(PORT, () => {
  console.log(`[Allaria Hub API] Running on port ${PORT}`)
  reconcileProjects()
})

// Reconcilia proyectos 'creating' o 'error' chequeando el estado real en el sandbox
async function reconcileProjects() {
  const slugFromEmail = (email) => email.split('@')[0].replace(/\./g, '-').toLowerCase()

  try {
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
  } catch (err) {
    console.error('[reconcile] Error:', err.message)
  }

  // Volver a correr cada 5 minutos
  setTimeout(reconcileProjects, 5 * 60 * 1000)
}
