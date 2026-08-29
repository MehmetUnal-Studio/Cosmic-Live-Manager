import test from 'node:test'
import assert from 'node:assert/strict'
import { createParamBatcher } from '../src/utils/paramBatcher.js'

// Manual scheduler: collects flush callbacks so tests control the "frame".
function manualScheduler() {
  const queue = []
  return {
    schedule: (cb) => {
      const handle = { cb, cancelled: false }
      queue.push(handle)
      return handle
    },
    cancel: (handle) => { handle.cancelled = true },
    tick() {
      const pending = queue.splice(0)
      for (const h of pending) if (!h.cancelled) h.cb()
    },
    get scheduledCount() { return queue.filter((h) => !h.cancelled).length }
  }
}

test('coalesces multiple values per (device,path) keeping only the last', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })

  b.push(1, '/freq', [100], 'f')
  b.push(1, '/freq', [200], 'f')
  b.push(1, '/freq', [300], 'f')
  b.push(1, '/amp', [0.5], 'f')
  b.push(2, '/x', [1, 2], 'ff')

  assert.equal(flushes.length, 0, 'nothing flushed before the frame')
  assert.equal(b.pendingCount(), 3)

  sched.tick()

  assert.equal(flushes.length, 1, 'exactly one flush per frame')
  const batch = flushes[0]
  assert.equal(batch.size, 2)
  assert.deepEqual(batch.get(1).get('/freq'), { value: [300], paramType: 'f' })
  assert.deepEqual(batch.get(1).get('/amp'), { value: [0.5], paramType: 'f' })
  assert.deepEqual(batch.get(2).get('/x'), { value: [1, 2], paramType: 'ff' })
  assert.equal(b.pendingCount(), 0)
})

test('schedules at most one flush per window (flood does not stack timers)', () => {
  const sched = manualScheduler()
  const b = createParamBatcher({ onFlush: () => {}, schedule: sched.schedule, cancel: sched.cancel })
  for (let i = 0; i < 500; i++) b.push(1, '/p' + (i % 10), [i], 'f')
  assert.equal(sched.scheduledCount, 1, 'one scheduled flush for 500 messages')
  assert.equal(b.pendingCount(), 10)
})

test('flushNow applies synchronously and cancels the pending schedule', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })
  b.push(7, '/a', [1], 'i')
  const returned = b.flushNow()
  assert.equal(flushes.length, 1)
  assert.equal(returned, flushes[0])
  assert.equal(b.isScheduled, false)
  sched.tick() // the cancelled frame callback must not double-flush
  assert.equal(flushes.length, 1)
})

test('flushNow with empty buffer is a no-op returning null', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })
  assert.equal(b.flushNow(), null)
  assert.equal(flushes.length, 0)
})

test('dropDevice removes buffered entries for one device only', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })
  b.push(1, '/a', [1], 'f')
  b.push(2, '/b', [2], 'f')
  b.dropDevice(1)
  sched.tick()
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].has(1), false)
  assert.deepEqual(flushes[0].get(2).get('/b'), { value: [2], paramType: 'f' })
})

test('clear drops the whole buffer without flushing', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })
  b.push(1, '/a', [1], 'f')
  b.clear()
  sched.tick()
  assert.equal(flushes.length, 0)
  assert.equal(b.pendingCount(), 0)
})

test('pushes after a flush start a fresh window with fresh maps', () => {
  const sched = manualScheduler()
  const flushes = []
  const b = createParamBatcher({
    onFlush: (batch) => flushes.push(batch),
    schedule: sched.schedule,
    cancel: sched.cancel
  })
  b.push(1, '/a', [1], 'f')
  sched.tick()
  b.push(1, '/a', [2], 'f')
  sched.tick()
  assert.equal(flushes.length, 2)
  assert.notEqual(flushes[0], flushes[1])
  assert.deepEqual(flushes[0].get(1).get('/a'), { value: [1], paramType: 'f' })
  assert.deepEqual(flushes[1].get(1).get('/a'), { value: [2], paramType: 'f' })
  // First batch must not have been mutated by the second window's pushes.
  assert.equal(flushes[0].get(1).size, 1)
})

test('falls back to setTimeout(16) when no scheduler injected and rAF absent', async () => {
  const flushes = []
  const b = createParamBatcher({ onFlush: (batch) => flushes.push(batch) })
  b.push(1, '/a', [42], 'f')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0].get(1).get('/a'), { value: [42], paramType: 'f' })
})
