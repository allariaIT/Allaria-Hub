import { describe, it } from 'node:test'
import assert from 'node:assert'
import { generateNginxConfig } from '../src/lib/nginx.js'

describe('generateNginxConfig', () => {
  it('generates valid server block with locations', () => {
    const projects = [
      { userSlug: 'juan-perez', name: 'dashboard', port: 4001 },
      { userSlug: 'maria-gomez', name: 'portal', port: 4002 },
    ]
    const config = generateNginxConfig(projects)

    assert.ok(config.includes('listen 3099'))
    assert.ok(config.includes('location /juan-perez/dashboard/'))
    assert.ok(config.includes('proxy_pass http://localhost:4001/'))
    assert.ok(config.includes('location /maria-gomez/portal/'))
    assert.ok(config.includes('proxy_pass http://localhost:4002/'))
  })

  it('generates empty server block when no projects', () => {
    const config = generateNginxConfig([])
    assert.ok(config.includes('listen 3099'))
    assert.ok(!config.includes('location /'))
  })
})
