import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { getAuthUrl, exchangeCode, SCOPES_MAP } from '../lib/google-oauth.js'

export const connectorRouter = Router()

// GET /api/connectors - Listar conexiones del usuario
connectorRouter.get('/', async (req, res) => {
  const connections = await prisma.userConnection.findMany({
    where: { userId: req.user.id },
    select: { id: true, provider: true, scopes: true, createdAt: true },
  })
  res.json(connections)
})

// POST /api/connectors/auth - Iniciar OAuth para un provider
connectorRouter.post('/auth', async (req, res) => {
  const { provider } = req.body
  if (!SCOPES_MAP[provider]) {
    return res.status(400).json({ error: 'Provider no soportado' })
  }
  const url = getAuthUrl(provider, req.user.id)
  res.json({ url })
})

// GET /api/connectors/callback - Google OAuth callback
connectorRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query
  if (!code || !state) {
    return res.status(400).send('Faltan parámetros')
  }

  try {
    const { provider, userId } = JSON.parse(state)
    const tokens = await exchangeCode(code)

    await prisma.userConnection.upsert({
      where: { userId_provider: { userId, provider } },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        scopes: (tokens.scope || '').replace(/ /g, ','),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
      create: {
        userId,
        provider,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        scopes: (tokens.scope || '').replace(/ /g, ','),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
    })

    const frontUrl = process.env.FRONT_URL || 'https://hub.allaria.xyz'
    res.redirect(`${frontUrl}/chat?connected=${provider}`)
  } catch (err) {
    console.error('OAuth callback error:', err.message)
    res.status(500).send('Error al conectar. Intentá de nuevo.')
  }
})

// DELETE /api/connectors/:provider - Desconectar un provider
connectorRouter.delete('/:provider', async (req, res) => {
  const deleted = await prisma.userConnection.deleteMany({
    where: { userId: req.user.id, provider: req.params.provider },
  })
  if (deleted.count === 0) return res.status(404).json({ error: 'Conexión no encontrada' })
  res.json({ ok: true })
})
