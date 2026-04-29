import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { getToolsForConnectors, executeTool, CONFIRMABLE_TOOLS } from '../lib/tools.js'

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

async function autoTitle(chat, chatId, lastUserMsg, data) {
  const msgCount = await prisma.message.count({ where: { chatId, role: 'user' } })
  if (msgCount === 1 && chat.title === 'Nuevo chat') {
    const text = extractTextForDb(lastUserMsg.content)
    const title = text.slice(0, 50) + (text.length > 50 ? '...' : '')
    if (title) {
      await prisma.chat.update({ where: { id: chatId }, data: { title } })
      data._chatTitle = title
    }
  }
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
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

    // Guardar mensaje del usuario
    const lastUserMsg = messages[messages.length - 1]
    if (lastUserMsg.role === 'user') {
      await prisma.message.create({
        data: { chatId, role: 'user', content: extractTextForDb(lastUserMsg.content) },
      })
    }

    const tools = getToolsForConnectors(connectors)

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

      // Separar tools confirmables de las que se ejecutan directo
      const pendingConfirmations = []
      const autoExecute = []

      for (const toolCall of assistantMsg.tool_calls) {
        if (CONFIRMABLE_TOOLS.has(toolCall.function.name)) {
          pendingConfirmations.push(toolCall)
        } else {
          autoExecute.push(toolCall)
        }
      }

      // Si hay confirmaciones pendientes, pausar y devolver al frontend
      if (pendingConfirmations.length > 0) {
        // Ejecutar las tools automáticas primero
        for (const toolCall of autoExecute) {
          let result
          try { result = await executeTool(toolCall, req.user.id) }
          catch (err) { result = { error: err.message } }
          llmMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
        }

        // Devolver las confirmaciones pendientes
        const confirmations = pendingConfirmations.map(tc => ({
          toolCallId: tc.id,
          toolName: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        }))

        return res.json({
          _pendingConfirmations: confirmations,
          _llmMessages: llmMessages,
          _model: model,
          _connectors: connectors,
          _chatId: chatId,
        })
      }

      // Ejecutar todas las tools (ninguna necesita confirmación)
      for (const toolCall of assistantMsg.tool_calls) {
        let result
        try { result = await executeTool(toolCall, req.user.id) }
        catch (err) { result = { error: err.message } }
        llmMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
      }

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
    await prisma.message.create({ data: { chatId, role: 'assistant', content: assistantContent, model } })
    await autoTitle(chat, chatId, lastUserMsg, data)

    res.json(data)
  } catch (err) {
    console.error('Proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// POST /api/chat/confirm - Confirmar o rechazar acciones pendientes
proxyRouter.post('/confirm', async (req, res) => {
  try {
    const { chatId, model, connectors = [], llmMessages, confirmations, temperature = 0.7, max_tokens = 4096 } = req.body

    if (!chatId || !llmMessages || !confirmations) {
      return res.status(400).json({ error: 'chatId, llmMessages y confirmations son requeridos' })
    }

    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: req.user.id },
    })
    if (!chat) return res.status(404).json({ error: 'Chat no encontrado' })

    const tools = getToolsForConnectors(connectors)
    let messages = [...llmMessages]

    // Procesar cada confirmación
    for (const conf of confirmations) {
      if (conf.approved) {
        // Ejecutar la tool
        const toolCall = { function: { name: conf.toolName, arguments: JSON.stringify(conf.args) } }
        let result
        try { result = await executeTool(toolCall, req.user.id) }
        catch (err) { result = { error: err.message } }
        messages.push({ role: 'tool', tool_call_id: conf.toolCallId, content: JSON.stringify(result) })
      } else {
        // Rechazada por el usuario
        messages.push({
          role: 'tool',
          tool_call_id: conf.toolCallId,
          content: JSON.stringify({ rejected: true, message: 'El usuario canceló esta acción.' }),
        })
      }
    }

    // Continuar la conversación con el LLM
    let data = await callLiteLLM({
      model,
      messages,
      temperature,
      max_tokens,
      user: req.user.email,
      tools,
    })

    // Continuar loop si hay más tool calls
    let rounds = 0
    while (
      data.choices?.[0]?.message?.tool_calls?.length > 0 &&
      rounds < MAX_TOOL_ROUNDS
    ) {
      const assistantMsg = data.choices[0].message
      messages.push(assistantMsg)

      // Chequear si hay más confirmables
      const pending = assistantMsg.tool_calls.filter(tc => CONFIRMABLE_TOOLS.has(tc.function.name))
      if (pending.length > 0) {
        const autoExec = assistantMsg.tool_calls.filter(tc => !CONFIRMABLE_TOOLS.has(tc.function.name))
        for (const toolCall of autoExec) {
          let result
          try { result = await executeTool(toolCall, req.user.id) }
          catch (err) { result = { error: err.message } }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
        }

        return res.json({
          _pendingConfirmations: pending.map(tc => ({
            toolCallId: tc.id,
            toolName: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          })),
          _llmMessages: messages,
          _model: model,
          _connectors: connectors,
          _chatId: chatId,
        })
      }

      for (const toolCall of assistantMsg.tool_calls) {
        let result
        try { result = await executeTool(toolCall, req.user.id) }
        catch (err) { result = { error: err.message } }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
      }

      data = await callLiteLLM({
        model,
        messages,
        temperature,
        max_tokens,
        user: req.user.email,
        tools,
      })
      rounds++
    }

    const assistantContent = data.choices?.[0]?.message?.content || 'Sin respuesta.'
    await prisma.message.create({ data: { chatId, role: 'assistant', content: assistantContent, model } })
    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })

    res.json(data)
  } catch (err) {
    console.error('Confirm error:', err.message)
    res.status(502).json({ error: err.message })
  }
})
