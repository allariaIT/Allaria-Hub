import { describe, it, expect } from 'vitest'
import { stripImageParts, buildUserContent } from '../agent.js'

describe('stripImageParts', () => {
  it('quita las partes image_url y marca stripped, sin mutar el original', () => {
    const messages = [
      { role: 'system', content: 's' },
      { role: 'user', content: [
        { type: 'text', text: 'hola' },
        { type: 'image_url', image_url: { url: 'data:x' } },
        { type: 'text', text: 'nota' },
      ] },
    ]
    const { messages: out, stripped } = stripImageParts(messages)
    expect(stripped).toBe(true)
    expect(out[1].content).toEqual([{ type: 'text', text: 'hola' }, { type: 'text', text: 'nota' }])
    expect(messages[1].content).toHaveLength(3)
  })

  it('no marca stripped si no hay image_url', () => {
    const { stripped } = stripImageParts([{ role: 'user', content: 'texto plano' }])
    expect(stripped).toBe(false)
  })
})

describe('buildUserContent note gate', () => {
  it('omite la frase de imágenes cuando no hay adjuntos visuales', () => {
    const parts = buildUserContent('usá datos', [{ name: 'd.csv', mimeType: 'text/csv', path: '.attachments/d.csv' }])
    expect(parts[parts.length - 1].text).not.toContain('ya están incluidos arriba')
  })

  it('incluye la frase cuando hay una imagen', () => {
    const parts = buildUserContent('mirá', [{ name: 'a.png', mimeType: 'image/png', path: '.attachments/a.png', base64: 'data:image/png;base64,AAA' }])
    expect(parts[parts.length - 1].text).toContain('ya están incluidos arriba')
  })
})
