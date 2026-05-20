import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { getToolsForConnectors, executeTool, CONFIRMABLE_TOOLS } from '../lib/tools.js'
import { createSessionPod, waitForPodReady } from '../lib/k8s.js'
import { pollGitlabPipeline } from '../lib/sandbox-tools.js'

const GITLAB_TOKEN = process.env.GITLAB_TOKEN

function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  const base = url.endsWith('.git') ? url : url + '.git'
  return base.replace(/https:\/\/gitlab\.allaria\.xyz/, `https://oauth2:${GITLAB_TOKEN}@gitlab.allaria.xyz`)
}

async function getOrCreateSession(userId, projectId) {
  let session = await prisma.session.findFirst({
    where: { userId, projectId, status: { not: 'dead' } },
    orderBy: { createdAt: 'desc' },
  })

  if (session) return session

  const project = await prisma.project.findFirst({ where: { id: projectId, userId } })
  if (!project) throw new Error('Proyecto no encontrado')

  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const podName = await createSessionPod(
    sessionId,
    repoUrlWithAuth(project.repoUrl),
    process.env.LITELLM_URL,
    process.env.LITELLM_KEY,
  )

  let newSession
  try {
    newSession = await prisma.session.create({
      data: { id: sessionId, userId, projectId, podName, status: 'starting' },
    })
  } catch (dbErr) {
    // Rollback pod on DB failure
    const { deleteSessionPod } = await import('../lib/k8s.js')
    deleteSessionPod(podName).catch(() => {})
    throw dbErr
  }

  return newSession
}

export const proxyRouter = Router()

const LITELLM_URL = process.env.LITELLM_URL || 'https://litellm.allaria.xyz/v1/chat/completions'
const LITELLM_KEY = process.env.LITELLM_KEY
const MAX_TOOL_ROUNDS = 20

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

    // Inyectar fecha y hora actual de Buenos Aires como contexto del sistema
    const now = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      dateStyle: 'full',
      timeStyle: 'short',
    })
    const systemContext = { role: 'system', content: `Fecha y hora actual en Buenos Aires: ${now}.` }
    let llmMessages = [systemContext, ...messages]

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

    const assistantContent = data.choices?.[0]?.message?.content || 'La tarea tomó demasiado tiempo o no generó una respuesta. Podés pedirme que continúe o dividir la tarea en pasos más chicos.'
    await prisma.message.create({ data: { chatId, role: 'assistant', content: assistantContent, model } })
    await autoTitle(chat, chatId, lastUserMsg, data)

    res.json(data)
  } catch (err) {
    console.error('Proxy error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// POST /api/chat/stream - Streaming SSE con progreso de tools (para project workspace)
proxyRouter.post('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Detectar si el cliente sigue conectado sin abortar el procesamiento
  let clientConnected = true
  req.on('close', () => { clientConnected = false })

  // Heartbeat cada 15s para evitar timeouts de nginx/browser
  const heartbeat = setInterval(() => {
    if (clientConnected) try { res.write(': ping\n\n') } catch {}
  }, 15000)

  const send = (obj) => {
    if (clientConnected) try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {}
  }

  try {
    const { chatId, model, messages, connectors = [], temperature = 0.7, max_tokens = 8192, projectId } = req.body

    if (!chatId || !messages?.length) {
      send({ type: 'error', message: 'chatId y messages son requeridos' })
      return
    }

    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } })
    if (!chat) { send({ type: 'error', message: 'Chat no encontrado' }); return }

    const lastUserMsg = messages[messages.length - 1]
    if (lastUserMsg.role === 'user') {
      await prisma.message.create({
        data: { chatId, role: 'user', content: extractTextForDb(lastUserMsg.content) },
      })
    }

    // Branch workspace con session pod
    if (projectId) {
      await handleWorkspaceStream(req, res, { chatId, messages, projectId, send, heartbeat })
      return
    }

    const tools = getToolsForConnectors(connectors)

    const now = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      dateStyle: 'full',
      timeStyle: 'short',
    })
    const systemContext = { role: 'system', content: `Fecha y hora actual en Buenos Aires: ${now}.` }
    let llmMessages = [systemContext, ...messages]

    send({ type: 'thinking' })

    let data = await callLiteLLM({
      model, messages: llmMessages, temperature, max_tokens,
      user: req.user.email,
      ...(tools.length > 0 ? { tools } : {}),
    })

    let rounds = 0
    while (data.choices?.[0]?.message?.tool_calls?.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      const assistantMsg = data.choices[0].message
      llmMessages.push(assistantMsg)

      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function.name
        let args = {}
        try { args = JSON.parse(toolCall.function.arguments) } catch {}

        send({ type: 'tool_start', name: toolName, args })

        let result
        try { result = await executeTool(toolCall, req.user.id) }
        catch (err) { result = { error: err.message } }

        send({ type: 'tool_done', name: toolName, result })
        llmMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
      }

      send({ type: 'thinking' })
      data = await callLiteLLM({
        model, messages: llmMessages, temperature, max_tokens,
        user: req.user.email, tools,
      })
      rounds++
    }

    const assistantContent = data.choices?.[0]?.message?.content || 'La tarea tomó demasiado tiempo o no generó una respuesta. Podés pedirme que continúe o dividir la tarea en pasos más chicos.'
    // Siempre guardar en DB aunque el cliente se haya desconectado
    await prisma.message.create({ data: { chatId, role: 'assistant', content: assistantContent, model } })
    await autoTitle(chat, chatId, lastUserMsg, data)

    send({ type: 'done', content: assistantContent })
  } catch (err) {
    console.error('Stream error:', err.message)
    send({ type: 'error', message: err.message })
  } finally {
    clearInterval(heartbeat)
    if (clientConnected) res.end()
  }
})

async function handleWorkspaceStream(req, res, { chatId, messages, projectId, send, heartbeat }) {
  try {
    const lastUserMsg = messages[messages.length - 1]

    // Obtener o crear sesión
    let session
    try {
      session = await getOrCreateSession(req.user.id, projectId)
    } catch (err) {
      send({ type: 'error', message: `Error iniciando sesión: ${err.message}` })
      return
    }

    // Esperar que el pod esté ready
    let podIP = session.podIP
    if (!podIP || session.status === 'starting') {
      send({ type: 'thinking', message: 'Preparando el agente...' })
      try {
        podIP = await waitForPodReady(session.podName, 60_000)
        await prisma.session.update({
          where: { id: session.id },
          data: { podIP, status: 'ready', lastActivity: new Date() },
        })
      } catch (err) {
        send({ type: 'error', message: `El agente no pudo iniciar: ${err.message}` })
        return
      }
    } else {
      await prisma.session.update({ where: { id: session.id }, data: { lastActivity: new Date() } })
    }

    // Proxy al pod
    const podRes = await fetch(`http://${podIP}:3200/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: lastUserMsg.content,
        history: messages.slice(0, -1),
      }),
      signal: AbortSignal.timeout(300_000),
    })

    if (!podRes.ok) {
      send({ type: 'error', message: `Pod respondió ${podRes.status}` })
      return
    }

    // Pipe SSE del pod al cliente
    const reader = podRes.body.getReader()
    const decoder = new TextDecoder()
    let assistantContent = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          send(data)
          if (data.type === 'done') assistantContent = data.content
          if (data.type === 'pushed') {
            // Update project status and poll CI
            const project = await prisma.project.findFirst({ where: { id: projectId } })
            if (project?.gitlabId) {
              await prisma.project.update({ where: { id: project.id }, data: { status: 'creating' } })
              pollGitlabPipeline(project.gitlabId, new Date()).then(async (result) => {
                await prisma.project.update({
                  where: { id: project.id },
                  data: { status: result.ok ? 'running' : 'error' },
                })
              }).catch(() => {})
            }
          }
        } catch {}
      }
    }

    if (assistantContent) {
      await prisma.message.create({
        data: { chatId, role: 'assistant', content: assistantContent, model: 'claude-sonnet-4-5' },
      })
      await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
    }
  } catch (err) {
    console.error('[workspace stream] error:', err.message)
    send({ type: 'error', message: err.message })
  }
}

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

    const assistantContent = data.choices?.[0]?.message?.content || 'La tarea tomó demasiado tiempo o no generó una respuesta. Podés pedirme que continúe o dividir la tarea en pasos más chicos.'
    await prisma.message.create({ data: { chatId, role: 'assistant', content: assistantContent, model } })
    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })

    res.json(data)
  } catch (err) {
    console.error('Confirm error:', err.message)
    res.status(502).json({ error: err.message })
  }
})
