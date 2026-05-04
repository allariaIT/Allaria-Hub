// sandbox-agent/tests/projects.test.js
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Test scaffold-only logic (no Docker/nginx in unit tests)
import { generateScaffold } from '../src/lib/scaffold.js'

describe('project creation flow', () => {
  let tmpDir

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('scaffold creates full project structure', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'))
    const projectDir = path.join(tmpDir, 'juan-perez', 'dashboard')

    generateScaffold(projectDir, {
      name: 'dashboard',
      title: 'Dashboard de Ventas',
      userSlug: 'juan-perez',
    })

    // Verify all files exist
    const files = ['package.json', 'vite.config.js', 'Dockerfile', '.dockerignore', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/App.css']
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(projectDir, f)), `Missing: ${f}`)
    }

    // Verify package.json is valid JSON
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'))
    assert.strictEqual(pkg.name, 'dashboard')
  })
})
