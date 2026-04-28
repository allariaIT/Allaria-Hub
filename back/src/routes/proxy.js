import { Router } from 'express'
import { prisma } from '../lib/prisma.js'

export const proxyRouter = Router()

const LITELLM_URL = process.env.LITELLM_URL || 'https://litellm.allaria.xyz/v1/chat/completions'
const LITELLM_KEY = process.env.LITELLM_KEY

// POST /api/chat/completions - Proxy a LiteLLM + guardar mensajes
proxyRouter.post('/completions', async (req, res) => {
  const { chatId, model, messages, temperature = 0.7, max_tokens = 4096 } = req.body

  if (!chatId || !messages?.length) {
    return res.status(400).json({ error: 'chatId y messages son requeridos' })
  }

  // Verificar que el chat pertenece al usuario
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId: req.user.id },
  })
  if (!chat) return res.status(404).json({ error: 'Chat no encontrado' })

  // Guardar mensaje del usuario
  const lastUserMsg = messages[messages.length - 1]
  if (lastUserMsg.role === 'user') {
    await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: lastUserMsg.content,
      },
    })
  }

  try {
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
      }),
    })

    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error))
    }

    const assistantContent = data.choices?.[0]?.message?.content || 'Sin respuesta.'

    // Guardar respuesta del asistente
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
      const title = lastUserMsg.content.slice(0, 50) + (lastUserMsg.content.length > 50 ? '...' : '')
      await prisma.chat.update({
        where: { id: chatId },
        data: { title },
      })
      data._chatTitle = title
    }

    // Actualizar timestamp del chat
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    })

    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})
