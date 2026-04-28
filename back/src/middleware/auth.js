import { OAuth2Client } from 'google-auth-library'
import { prisma } from '../lib/prisma.js'

const client = new OAuth2Client()

export async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' })
  }

  const token = header.slice(7)

  try {
    // Try Google ID token verification
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()

    // Upsert user
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

    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' })
  }
}
