// sandbox-agent/tests/auth.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createAuthMiddleware } from '../src/middleware/auth.js'

describe('auth middleware', () => {
  const auth = createAuthMiddleware('test-secret')

  it('rejects requests without X-Sandbox-Key', () => {
    let statusCode, body
    const req = { headers: {} }
    const res = {
      status(code) { statusCode = code; return this },
      json(data) { body = data },
    }
    const next = () => { throw new Error('should not call next') }

    auth(req, res, next)
    assert.strictEqual(statusCode, 401)
    assert.strictEqual(body.error, 'Unauthorized')
  })

  it('rejects requests with wrong key', () => {
    let statusCode, body
    const req = { headers: { 'x-sandbox-key': 'wrong' } }
    const res = {
      status(code) { statusCode = code; return this },
      json(data) { body = data },
    }
    const next = () => { throw new Error('should not call next') }

    auth(req, res, next)
    assert.strictEqual(statusCode, 401)
    assert.strictEqual(body.error, 'Unauthorized')
  })

  it('allows requests with correct key', () => {
    let called = false
    const req = { headers: { 'x-sandbox-key': 'test-secret' } }
    const res = {}
    const next = () => { called = true }

    auth(req, res, next)
    assert.strictEqual(called, true)
  })
})
