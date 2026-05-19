import Anthropic from '@anthropic-ai/sdk'
import { toolDefinitions, executeTool } from './tools.js'

const MODEL = 'claude-sonnet-4-5'
const MAX_ROUNDS = 20

export async function* runAgent(userMessage, history, systemPrompt) {
  const client = new Anthropic({
    apiKey: process.env.LITELLM_KEY,
    baseURL: process.env.LITELLM_URL,
  })

  // history es array de { role: 'user'|'assistant', content: string }
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]

  let rounds = 0

  while (rounds < MAX_ROUNDS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      tools: toolDefinitions,
    })

    // Emitir texto de la respuesta
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        yield { type: 'text', content: block.text }
      }
    }

    if (response.stop_reason === 'end_turn') break

    if (response.stop_reason === 'max_tokens') {
      yield { type: 'error', message: 'Respuesta truncada por límite de tokens. Podés pedirme que continúe.' }
      break
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        yield { type: 'tool_start', name: block.name, args: block.input }

        let result
        try {
          result = await executeTool(block.name, block.input)
        } catch (err) {
          result = { error: err.message }
        }

        yield { type: 'tool_done', name: block.name, result }

        if (block.name === 'git_push' && result.ok) {
          yield { type: 'pushed', commit: result.commit, filesChanged: result.filesChanged }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        })
      }

      messages.push({ role: 'user', content: toolResults })
      rounds++
      continue
    }

    break
  }
}
