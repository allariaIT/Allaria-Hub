import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Anthropic client
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}))

// Mock tools
vi.mock('../tools.js', () => ({
  toolDefinitions: [],
  executeTool: vi.fn(),
}))

import Anthropic from '@anthropic-ai/sdk'
import { executeTool } from '../tools.js'
import { runAgent } from '../agent.js'

async function collect(gen) {
  const events = []
  for await (const e of gen) events.push(e)
  return events
}

describe('runAgent', () => {
  let mockCreate

  beforeEach(() => {
    vi.clearAllMocks()
    // Reinstanciar para limpiar mocks
    const instance = { messages: { create: vi.fn() } }
    Anthropic.mockReturnValue(instance)
    mockCreate = instance.messages.create
  })

  it('emite text y termina en end_turn', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hola!' }],
    })

    const events = await collect(runAgent('hola', [], 'system prompt'))
    expect(events).toContainEqual({ type: 'text', content: 'Hola!' })
  })

  it('ejecuta tool y continúa el loop', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Los archivos son...' }],
      })

    executeTool.mockResolvedValue({ files: ['src/App.jsx'] })

    const events = await collect(runAgent('listá los archivos', [], 'sys'))
    expect(events.some(e => e.type === 'tool_start' && e.name === 'list_files')).toBe(true)
    expect(events.some(e => e.type === 'tool_done')).toBe(true)
    expect(events.some(e => e.type === 'text')).toBe(true)
  })

  it('emite pushed cuando git_push retorna ok:true', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'git_push', input: { message: 'feat: add button' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '✅ Pusheado' }],
      })

    executeTool.mockResolvedValue({ ok: true, pushed: true, commit: 'abc123', filesChanged: ['src/App.jsx'] })

    const events = await collect(runAgent('pusheá', [], 'sys'))
    const pushedEvent = events.find(e => e.type === 'pushed')
    expect(pushedEvent).toBeDefined()
    expect(pushedEvent.commit).toBe('abc123')
  })
})
