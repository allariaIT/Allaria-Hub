import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'))
  process.env.WORKSPACE_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.WORKSPACE_DIR
  vi.resetModules()
})

async function getModule() {
  return await import('../attachments.js')
}

describe('writeAttachments', () => {
  it('devuelve [] con lista vacía o inválida', async () => {
    const { writeAttachments } = await getModule()
    expect(writeAttachments([])).toEqual([])
    expect(writeAttachments()).toEqual([])
  })

  it('escribe un archivo de texto en .attachments/', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: 'datos.csv', type: 'text/csv', textContent: 'a,b\n1,2' }])
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('.attachments/datos.csv')
    const written = fs.readFileSync(path.join(tmpDir, '.attachments', 'datos.csv'), 'utf-8')
    expect(written).toBe('a,b\n1,2')
  })

  it('decodifica base64 de un data URL para binarios', async () => {
    const { writeAttachments } = await getModule()
    // "hola" en base64 = aG9sYQ==
    const dataUrl = 'data:image/png;base64,aG9sYQ=='
    const out = writeAttachments([{ name: 'logo.png', type: 'image/png', base64: dataUrl }])
    expect(out[0].base64).toBe(dataUrl)
    const buf = fs.readFileSync(path.join(tmpDir, '.attachments', 'logo.png'))
    expect(buf.toString('utf-8')).toBe('hola')
  })

  it('resuelve colisiones de nombre con sufijo -N', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([
      { name: 'a.txt', type: 'text/plain', textContent: 'uno' },
      { name: 'a.txt', type: 'text/plain', textContent: 'dos' },
    ])
    expect(out[0].path).toBe('.attachments/a.txt')
    expect(out[1].path).toBe('.attachments/a-1.txt')
    expect(fs.readFileSync(path.join(tmpDir, '.attachments', 'a-1.txt'), 'utf-8')).toBe('dos')
  })

  it('sanea path traversal quedándose con el basename', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: '../../etc/passwd', type: 'text/plain', textContent: 'x' }])
    expect(out[0].path).toBe('.attachments/passwd')
    expect(fs.existsSync(path.join(tmpDir, '.attachments', 'passwd'))).toBe(true)
  })

  it('saltea adjuntos sin contenido', async () => {
    const { writeAttachments } = await getModule()
    const out = writeAttachments([{ name: 'vacio.bin', type: 'application/octet-stream' }])
    expect(out).toEqual([])
  })
})
