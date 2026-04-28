import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'

export async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' })
  }

  const token = header.slice(7)

  try {
    // Find user whose session token matches
    const users = await prisma.user.findMany()
    const user = users.find(u => {
      const expectedToken = crypto.createHash('sha256')
        .update(u.id + process.env.GOOGLE_CLIENT_ID)
        .digest('hex')
      return expectedToken === token
    })

    if (!user) {
      return res.status(401).json({ error: 'Token inválido' })
    }

    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Error de autenticación' })
  }
}
