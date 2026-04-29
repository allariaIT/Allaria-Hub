import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { getToolsForConnectors, executeTool } from '../lib/tools.js'

export const proxyRouter = Router()

const LITELLM_URL = process.env.LITELLM_URL || 'https://litellm.allaria.xyz/v1/chat/completions'
const LITELLM_KEY = process.env.LITELLM_KEY
const MAX_TOOL_ROUNDS = 5

function extractTextForDb(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (p.type === 'text' && !p.text.startsWith('--- Archivo:')) {
        parts.push(p.text)
      } else if (p.type === 'text' && p.text.startsWith('--- Archivo:')) {
        const name = p.text.split('\n')[0].replace('--- Archivo: ', '').replace(' ---', '')
        parts.push(`[📎 ${name}]`)
      } else if (p.type === 'image_url') {
        parts.push('[📎 Adjunto]')
      }
    }
    return parts.join('\n').replace(/\[📎 Adjunto\]\n\[📎 /g, '[📎 ')
  }
  return ''
}

async function callLiteLLM(body) {
  const response = await fetch(LITELLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LITELLM_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error))
  }
  return data
}

// POST /api/chat/completions - Proxy a LiteLLM + tool calling + guardar mensajes
proxyRouter.post('/completions', async (req, res) => {
  try {
    const { chatId, model, messages, connectors = [], temperature = 0.7, max_tokens = 4096 } = req.body

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

    // Obtener tools según conectores activos
    const tools = getToolsForConnectors(connectors)

    // Primera llamada a LiteLLM
    let llmMessages = [...messages]
    let data = await callLiteLLM({
      model,
      messages: llmMessages,
      temperature,
      max_tokens,
      user: req.user.email,
      ...(tools.length > 0 ? { tools } : {}),
    })

    // Tool calling loop
    let rounds = 0
    while (
      data.choices?.[0]?.message?.tool_calls?.length > 0 &&
      rounds < MAX_TOOL_ROUNDS
    ) {
      const assistantMsg = data.choices[0].message
      llmMessages.push(assistantMsg)

      // Ejecutar cada tool call
      for (const toolCall of assistantMsg.tool_calls) {
        let result
        try {
          result = await executeTool(toolCall, req.user.id)
        } catch (err) {
          result = { error: err.message }
        }

        llmMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      }

      // Siguiente ronda
      data = await callLiteLLM({
        model,
        messages: llmMessages,
        temperature,
        max_tokens,
        user: req.user.email,
        tools,
      })
      rounds++
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
