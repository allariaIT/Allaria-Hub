import { Router } from 'express'
import { prisma } from '../lib/prisma.js'

export const proxyRouter = Router()

const LITELLM_URL = process.env.LITELLM_URL || 'https://litellm.allaria.xyz/v1/chat/completions'
const LITELLM_KEY = process.env.LITELLM_KEY

function extractTextForDb(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (p.type === 'text') parts.push(p.text)
      if (p.type === 'image_url') parts.push('[📎 Imagen adjunta]')
    }
    return parts.join('\n')
  }
  return ''
}

// POST /api/chat/completions - Proxy a LiteLLM + guardar mensajes
proxyRouter.post('/completions', async (req, res) => {
  try {
    const { chatId, model, messages, temperature = 0.7, max_tokens = 4096 } = req.body

    if (!chatId || !messages?.length) {
      return res.status(400).json({ error: 'chatId y messages son requeridos' })
    }

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: req.user.id },
    })
    if (!chat) return res.status(404).json({ error: 'Chat no encontrado' })

    // Guardar mensaje del usuario (texto plano para DB)
    const lastUserMsg = messages[messages.length - 1]
    if (lastUserMsg.role === 'user') {
      await prisma.message.create({
        data: {
          chatId,
          role: 'user',
          content: extractTextForDb(lastUserMsg.content),
        },
      })
    }

    // Proxy a LiteLLM
    const response = await fetch(LITELLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LITELLM_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens,
        user: req.user.email,
      }),
    })

    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error))
    }

    const assistantContent = data.choices?.[0]?.message?.content || 'Sin respuesta.'

    await prisma.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: assistantContent,
        model,
      },
    })

    // Auto-título en primer intercambio
    const msgCount = await prisma.message.count({ where: { chatId, role: 'user' } })
    if (msgCount === 1 && chat.title === 'Nuevo chat') {
      const text = extractTextForDb(lastUserMsg.content)
      const title = text.slice(0, 50) + (text.length > 50 ? '...' : '')
      if (title) {
        await prisma.chat.update({
          where: { id: chatId },
          data: { title },
        })
        data._chatTitle = title
      }
    }

    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    })

    res.json(data)
  } catch (err) {
    console.error('Proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})
