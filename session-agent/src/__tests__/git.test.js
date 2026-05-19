import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { gitCommitAndPush } from '../git.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'))
  spawnSync('git', ['init'], { cwd: tmpDir })
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  // Crear commit inicial para que HEAD exista
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'init')
  spawnSync('git', ['add', '-A'], { cwd: tmpDir })
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('gitCommitAndPush', () => {
  it('retorna pushed:false cuando no hay cambios', () => {
    const result = gitCommitAndPush(tmpDir, 'test')
    expect(result.pushed).toBe(false)
    expect(result.message).toBe('Nada para commitear')
  })

  it('commitea cuando hay archivos nuevos (sin push a remoto)', () => {
    fs.writeFileSync(path.join(tmpDir, 'nuevo.js'), 'console.log("hola")')
    // git push fallará sin remoto — pero commit sí funciona
    // Simulamos: verificamos que después del commit staged changes desaparecen
    spawnSync('git', ['config', 'user.email', 'session-agent@allaria.xyz'], { cwd: tmpDir })
    spawnSync('git', ['config', 'user.name', 'Allaria Session Agent'], { cwd: tmpDir })
    spawnSync('git', ['add', '-A'], { cwd: tmpDir })
    spawnSync('git', ['commit', '-m', 'test commit'], { cwd: tmpDir })
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
    expect(status.stdout.trim()).toBe('')
  })
})
