import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentsToRefs } from '../attachments-refs.js'

test('devuelve string vacío sin adjuntos', () => {
  assert.equal(attachmentsToRefs([]), '')
  assert.equal(attachmentsToRefs(), '')
})

test('lista refs [📎 nombre] separadas por salto de línea', () => {
  const r = attachmentsToRefs([{ name: 'a.png' }, { name: 'b.csv' }])
  assert.equal(r, '\n[📎 a.png]\n[📎 b.csv]')
})
