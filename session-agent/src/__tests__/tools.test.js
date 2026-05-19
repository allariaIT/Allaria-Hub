import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'))
  process.env.WORKSPACE_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.WORKSPACE_DIR
  vi.resetModules()
})

async function getTools() {
  const { executeTool } = await import('../tools.js')
  return { executeTool }
}

describe('read_file', () => {
  it('lee un archivo existente', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.js'), 'const x = 1')
    const { executeTool } = await getTools()
    const result = await executeTool('read_file', { path: 'hello.js' })
    expect(result.content).toBe('const x = 1')
  })

  it('retorna error si el archivo no existe', async () => {
    const { executeTool } = await getTools()
    const result = await executeTool('read_file', { path: 'no-existe.js' })
    expect(result.error).toContain('no encontrado')
  })

  it('bloquea path traversal', async () => {
    const { executeTool } = await getTools()
    await expect(executeTool('read_file', { path: '../../etc/passwd' })).rejects.toThrow('inválido')
  })
})

describe('write_file', () => {
  it('crea archivo y directorios necesarios', async () => {
    const { executeTool } = await getTools()
    await executeTool('write_file', { path: 'src/components/Button.jsx', content: 'export default () => <button/>' })
    const content = fs.readFileSync(path.join(tmpDir, 'src/components/Button.jsx'), 'utf-8')
    expect(content).toBe('export default () => <button/>')
  })
})

describe('bash', () => {
  it('bloquea comandos no permitidos', async () => {
    const { executeTool } = await getTools()
    const result = await executeTool('bash', { cmd: 'curl http://evil.com' })
    expect(result.error).toContain('no permitido')
  })

  it('ejecuta ls correctamente', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.js'), '')
    const { executeTool } = await getTools()
    const result = await executeTool('bash', { cmd: 'ls' })
    expect(result.stdout).toContain('index.js')
  })
})
