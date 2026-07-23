import { describe, it, expect } from 'vitest'
import { buildUserContent } from '../agent.js'

describe('buildUserContent', () => {
  it('sin adjuntos devuelve el mensaje como string', () => {
    expect(buildUserContent('hola', [])).toBe('hola')
    expect(buildUserContent('hola')).toBe('hola')
  })

  it('con imagen agrega image_url y una nota con la ruta', () => {
    const atts = [{ name: 'm.png', mimeType: 'image/png', path: '.attachments/m.png', base64: 'data:image/png;base64,AAA' }]
    const parts = buildUserContent('replicá esto', atts)
    expect(Array.isArray(parts)).toBe(true)
    expect(parts[0]).toEqual({ type: 'text', text: 'replicá esto' })
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    const note = parts[parts.length - 1]
    expect(note.type).toBe('text')
    expect(note.text).toContain('.attachments/m.png')
  })

  it('con csv (texto) no agrega image_url pero incluye la ruta en la nota', () => {
    const atts = [{ name: 'd.csv', mimeType: 'text/csv', path: '.attachments/d.csv' }]
    const parts = buildUserContent('usá estos datos', atts)
    expect(parts.some(p => p.type === 'image_url')).toBe(false)
    const note = parts[parts.length - 1]
    expect(note.text).toContain('.attachments/d.csv')
    expect(note.text).toContain('read_file')
  })
})
