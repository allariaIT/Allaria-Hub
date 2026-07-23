import { toolDefinitions, executeTool } from './tools.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_ROUNDS = 30
const MAX_AUTO_CONTINUE = 3
const LITELLM_TIMEOUT_MS = 3 * 60_000 // 3 min por llamada — si LiteLLM no responde, cortar
const VISIBLE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'])

export function buildUserContent(userMessage, attachments = []) {
  const atts = attachments ?? []
  if (!atts.length) return userMessage
  const parts = []
  if (userMessage) parts.push({ type: 'text', text: userMessage })
  let hasVisible = false
  for (const att of atts) {
    if (VISIBLE_MIME.has(att.mimeType) && att.base64) {
      parts.push({ type: 'image_url', image_url: { url: att.base64 } })
      hasVisible = true
    }
  }
  const list = atts.map(a => `- ${a.path} (${a.mimeType || 'desconocido'})`).join('\n')
  const visibleLine = hasVisible
    ? 'Las imágenes y PDFs ya están incluidos arriba para que los veas. '
    : ''
  parts.push({
    type: 'text',
    text: `Archivos adjuntos por el usuario, disponibles en el workspace:\n${list}\n\n${visibleLine}Para archivos de datos o texto (csv, json, txt, etc.) usá read_file con la ruta indicada. Estos archivos se commitean al repo cuando hagas git_push.`,
  })
  return parts
}

// Quita las partes image_url del mensaje de usuario. Devuelve nuevas copias
// (no muta el original) y marca si sacó algo.
export function stripImageParts(messages) {
  let stripped = false
  const out = messages.map(m => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const filtered = m.content.filter(p => p.type !== 'image_url')
      if (filtered.length !== m.content.length) stripped = true
      return { ...m, content: filtered.length ? filtered : '' }
    }
    return m
  })
  return { messages: out, stripped }
}

// Mantiene solo las últimas N rondas de tool calls para no explotar el contexto
function pruneToolRounds(messages, maxRounds = 6) {
  const roundStarts = messages.reduce((acc, m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) acc.push(i)
    return acc
  }, [])
  if (roundStarts.length <= maxRounds) return messages
  const keepFrom = roundStarts[roundStarts.length - maxRounds]
  const firstRound = roundStarts[0]
  return [...messages.slice(0, firstRound), ...messages.slice(keepFrom)]
}

async function callLiteLLM(messages) {
  const url = `${process.env.LITELLM_BASE_URL}/v1/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LITELLM_KEY}`,
      'Connection': 'close',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages,
      tools: toolDefinitions,
    }),
    signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`[agent] LiteLLM error ${res.status}:`, err.slice(0, 200))
    throw new Error(`LiteLLM ${res.status}: ${err}`)
  }
  const data = await res.json()
  console.log(`[agent] LiteLLM ok — finish_reason: ${data.choices?.[0]?.finish_reason}, tools: ${data.choices?.[0]?.message?.tool_calls?.length ?? 0}`)
  return data
}

export async function* runAgent(userMessage, history, systemPrompt, attachments = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: buildUserContent(userMessage, attachments) },
  ]

  let rounds = 0
  let autoContinues = 0

  while (rounds < MAX_ROUNDS) {
    let data
    try {
      data = await callLiteLLM(pruneToolRounds(messages))
    } catch (err) {
      const { messages: withoutImages, stripped } = stripImageParts(messages)
      if (!stripped) throw err
      // Un adjunto visual (imagen o PDF) no pudo procesarse. Reintentamos sin
      // las partes image_url para no romper todo el mensaje; el archivo ya
      // quedó materializado en .attachments/ y sigue en la nota de texto.
      messages.length = 0
      messages.push(...withoutImages)
      yield { type: 'text', content: '\n\n⚠️ No pude procesar visualmente un adjunto (imagen o PDF). Sigo con el resto: el archivo quedó en `.attachments/` y puedo leerlo con read_file si es de texto.\n\n' }
      data = await callLiteLLM(pruneToolRounds(messages))
    }
    const choice = data.choices?.[0]
    if (!choice) throw new Error('Respuesta vacía de LiteLLM')

    const msg = choice.message

    if (msg.content) {
      yield { type: 'text', content: msg.content }
    }

    const reason = choice.finish_reason

    if (reason === 'stop' || reason === 'end_turn') {
      // Detectar si el modelo escribió archivos pero olvidó hacer git_push
      const hasWrite = messages.some(m =>
        m.role === 'assistant' && m.tool_calls?.some(tc => tc.function.name === 'write_file')
      )
      const hasPushed = messages.some(m =>
        m.role === 'assistant' && m.tool_calls?.some(tc => tc.function.name === 'git_push')
      )
      if (hasWrite && !hasPushed && autoContinues < MAX_AUTO_CONTINUE) {
        // Auto-continuar: el modelo hizo cambios pero no los pusheó
        autoContinues++
        console.log(`[agent] auto-continue ${autoContinues}/${MAX_AUTO_CONTINUE}: write sin push detectado`)
        if (msg.content) messages.push({ role: 'assistant', content: msg.content })
        messages.push({ role: 'user', content: 'Los cambios están escritos pero falta hacer git_push. Hacelo ahora para terminar.' })
        continue
      }
      break
    }

    if (reason === 'length') {
      yield { type: 'error', message: 'Respuesta truncada por límite de tokens. Podés pedirme que continúe.' }
      break
    }

    if (reason === 'tool_calls' && msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls })

      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function.name
        let args
        try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }

        yield { type: 'tool_start', name, args }

        let result
        try { result = await executeTool(name, args) }
        catch (err) { result = { error: err.message } }

        yield { type: 'tool_done', name, result }

        if (name === 'git_push' && result.ok) {
          yield { type: 'pushed', commit: result.commit, filesChanged: result.filesChanged }
        }

        const MAX_RESULT = 4_000
        let resultContent = JSON.stringify(result)
        if (resultContent.length > MAX_RESULT) {
          resultContent = resultContent.slice(0, MAX_RESULT) + '…[truncado]'
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent })
      }

      rounds++
      continue
    }

    break
  }

  if (rounds >= MAX_ROUNDS) {
    yield { type: 'text', content: '\n\n⚠️ Alcancé el límite de pasos. Si la tarea no terminó, decime "continúa" para seguir.' }
  }
}
