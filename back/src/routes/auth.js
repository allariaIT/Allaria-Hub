import { Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'

const client = new OAuth2Client()
export const authRouter = Router()

// POST /api/auth/google - Verificar token de Google y crear/actualizar usuario
authRouter.post('/google', async (req, res) => {
  const { credential } = req.body
  if (!credential) {
    return res.status(400).json({ error: 'credential requerido' })
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()

    // Generate a simple session token
    const sessionToken = crypto.createHash('sha256')
      .update(payload.sub + process.env.GOOGLE_CLIENT_ID)
      .digest('hex')

    const user = await prisma.user.upsert({
      where: { id: payload.sub },
      update: {
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
      },
      create: {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
      },
    })

    res.json({ user, token: sessionToken })
  } catch (err) {
    console.error('Google auth error:', err.message)
    res.status(401).json({ error: 'Token de Google inválido', detail: err.message })
  }
})
