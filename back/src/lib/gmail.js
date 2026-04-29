import { google } from 'googleapis'
import { getAuthedClient } from './google-oauth.js'
import { prisma } from './prisma.js'

async function getGmailClient(userId) {
  const conn = await prisma.userConnection.findUnique({
    where: { userId_provider: { userId, provider: 'gmail' } },
  })
  if (!conn) throw new Error('Gmail no conectado. Pedile al usuario que conecte Gmail desde el panel de conectores.')

  const auth = getAuthedClient(conn.accessToken, conn.refreshToken)

  // Listener para auto-actualizar tokens
  auth.on('tokens', async (tokens) => {
    const update = { accessToken: tokens.access_token }
    if (tokens.refresh_token) update.refreshToken = tokens.refresh_token
    if (tokens.expiry_date) update.expiresAt = new Date(tokens.expiry_date)
    await prisma.userConnection.update({
      where: { id: conn.id },
      data: update,
    })
  })

  return google.gmail({ version: 'v1', auth })
}

function parseMessage(msg) {
  const headers = msg.payload?.headers || []
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

  let body = ''
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8')
  } else if (msg.payload?.parts) {
    const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain')
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf-8')
    }
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    snippet: msg.snippet,
    body: body.slice(0, 2000),
  }
}

export async function gmailListMessages(userId, { maxResults = 10, q = '' } = {}) {
  const gmail = await getGmailClient(userId)
  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: q || undefined,
  })

  if (!res.data.messages?.length) return { messages: [], total: 0 }

  const messages = await Promise.all(
    res.data.messages.map(async (m) => {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'full',
      })
      return parseMessage(full.data)
    })
  )

  return { messages, total: res.data.resultSizeEstimate || messages.length }
}

export async function gmailReadMessage(userId, messageId) {
  const gmail = await getGmailClient(userId)
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  })
  return parseMessage(res.data)
}

export async function gmailSendMessage(userId, { to, subject, body }) {
  const gmail = await getGmailClient(userId)

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')

  const encoded = Buffer.from(raw).toString('base64url')

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  })

  return { id: res.data.id, threadId: res.data.threadId }
}

export async function gmailSearchMessages(userId, query, maxResults = 5) {
  return gmailListMessages(userId, { maxResults, q: query })
}
