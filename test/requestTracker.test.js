import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestTracker } from '../src/utils/requestTracker.js'

test('settle resolves the matching pending request', async () => {
  const t = createRequestTracker({ timeoutMs: 5000 })
  const p = t.register('r1')
  assert.equal(t.size, 1)
  const hit = t.settle('r1', { ok: true })
  assert.equal(hit, true)
  assert.deepEqual(await p, { ok: true })
  assert.equal(t.size, 0)
})

test('settle on unknown id returns false and settles nothing', async () => {
  const t = createRequestTracker({ timeoutMs: 5000 })
  const p = t.register('r1')
  assert.equal(t.settle('nope', { ok: true }), false)
  assert.equal(t.size, 1)
  t.settle('r1', { ok: false, reason: 'target-unreachable' })
  assert.deepEqual(await p, { ok: false, reason: 'target-unreachable' })
})

test('unsettled request resolves with the timeout result (never rejects)', async () => {
  const t = createRequestTracker({ timeoutMs: 20, timeoutResult: { ok: false, reason: 'timeout' } })
  const p = t.register('slow')
  assert.deepEqual(await p, { ok: false, reason: 'timeout' })
  assert.equal(t.size, 0)
  // Late reply after timeout is a clean miss, not a crash.
  assert.equal(t.settle('slow', { ok: true }), false)
})

test('concurrent requests settle independently by id', async () => {
  const t = createRequestTracker({ timeoutMs: 5000 })
  const p1 = t.register('a')
  const p2 = t.register('b')
  t.settle('b', { ok: false, reason: 'rejected' })
  t.settle('a', { ok: true })
  assert.deepEqual(await p1, { ok: true })
  assert.deepEqual(await p2, { ok: false, reason: 'rejected' })
})

test('settleAll resolves everything pending with the given result', async () => {
  const t = createRequestTracker({ timeoutMs: 5000 })
  const p1 = t.register('a')
  const p2 = t.register('b')
  t.settleAll({ ok: false, reason: 'disconnected' })
  assert.deepEqual(await p1, { ok: false, reason: 'disconnected' })
  assert.deepEqual(await p2, { ok: false, reason: 'disconnected' })
  assert.equal(t.size, 0)
})

test('duplicate id: prior registration is settled as timeout, new one wins', async () => {
  const t = createRequestTracker({ timeoutMs: 5000, timeoutResult: { ok: false, reason: 'timeout' } })
  const first = t.register('dup')
  const second = t.register('dup')
  assert.deepEqual(await first, { ok: false, reason: 'timeout' })
  t.settle('dup', { ok: true })
  assert.deepEqual(await second, { ok: true })
})
