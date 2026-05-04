import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { generateScaffold } from '../src/lib/scaffold.js'

describe('generateScaffold', () => {
  let tmpDir

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates all expected files', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'test-project')

    generateScaffold(projectDir, {
      name: 'test-project',
      title: 'Test Project',
      userSlug: 'juan-perez',
    })

    assert.ok(fs.existsSync(path.join(projectDir, 'package.json')))
    assert.ok(fs.existsSync(path.join(projectDir, 'vite.config.js')))
    assert.ok(fs.existsSync(path.join(projectDir, 'Dockerfile')))
    assert.ok(fs.existsSync(path.join(projectDir, '.dockerignore')))
    assert.ok(fs.existsSync(path.join(projectDir, 'index.html')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'main.jsx')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'App.jsx')))
    assert.ok(fs.existsSync(path.join(projectDir, 'src', 'App.css')))
  })

  it('uses correct base path in vite config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'dashboard')

    generateScaffold(projectDir, {
      name: 'dashboard',
      title: 'Dashboard',
      userSlug: 'juan-perez',
    })

    const viteConfig = fs.readFileSync(path.join(projectDir, 'vite.config.js'), 'utf-8')
    assert.ok(viteConfig.includes("base: '/juan-perez/dashboard/'"))
  })

  it('uses project title in App.jsx', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'))
    const projectDir = path.join(tmpDir, 'mi-app')

    generateScaffold(projectDir, {
      name: 'mi-app',
      title: 'Mi Aplicacion',
      userSlug: 'maria',
    })

    const appJsx = fs.readFileSync(path.join(projectDir, 'src', 'App.jsx'), 'utf-8')
    assert.ok(appJsx.includes('Mi Aplicacion'))
  })
})
