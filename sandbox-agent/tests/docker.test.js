import { describe, it } from 'node:test'
import assert from 'node:assert'
import { findFreePort, containerName, imageName } from '../src/lib/docker.js'

describe('docker helpers', () => {
  it('containerName returns correct format', () => {
    assert.strictEqual(containerName('juan-perez', 'dashboard'), 'sandbox-juan-perez-dashboard')
  })

  it('imageName returns correct format', () => {
    assert.strictEqual(imageName('juan-perez', 'dashboard'), 'sandbox-juan-perez-dashboard:latest')
  })

  it('findFreePort returns first port when no containers running', async () => {
    // Mock: pass empty used ports set
    const port = findFreePort(new Set(), 4001, 4100)
    assert.strictEqual(port, 4001)
  })

  it('findFreePort skips used ports', () => {
    const used = new Set([4001, 4002, 4003])
    const port = findFreePort(used, 4001, 4100)
    assert.strictEqual(port, 4004)
  })

  it('findFreePort throws when all ports used', () => {
    const used = new Set([4001, 4002])
    assert.throws(
      () => findFreePort(used, 4001, 4002),
      /No hay puertos disponibles/
    )
  })
})
