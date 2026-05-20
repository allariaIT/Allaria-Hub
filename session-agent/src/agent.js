import { toolDefinitions, executeTool } from './tools.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_ROUNDS = 20

async function callLiteLLM(messages) {
  const url = `${process.env.LITELLM_BASE_URL}/v1/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LITELLM_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages,
      tools: toolDefinitions,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`LiteLLM ${res.status}: ${err}`)
  }
  return res.json()
}

export async function* runAgent(userMessage, history, systemPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  let rounds = 0

  while (rounds < MAX_ROUNDS) {
    const data = await callLiteLLM(messages)
    const choice = data.choices?.[0]
    if (!choice) throw new Error('Respuesta vacía de LiteLLM')

    const msg = choice.message

    if (msg.content) {
      yield { type: 'text', content: msg.content }
    }

    const reason = choice.finish_reason
    if (reason === 'stop' || reason === 'end_turn') break
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

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
      }

      rounds++
      continue
    }

    break
  }
}
