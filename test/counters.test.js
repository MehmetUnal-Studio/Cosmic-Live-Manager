import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COUNTER_CEILING,
  bumpCounter,
  formatCount,
  formatExact,
  formatRate,
  ratePerSecond
} from '../shared/counters.js'

// ─── The invariant the rig depends on ────────────────────────────────────
// A device card's counter label must never grow wide enough to push the card's
// controls out of a narrow layout, no matter how long the hub has been up.

test('a count label is never wider than 5 characters, at any magnitude', () => {
  const samples = [0, 1, 999, 1000, 9999, 44364, 909141, 999999, 5400000,
    999999999, 1234567890, 1e12, 999999999999999, COUNTER_CEILING, COUNTER_CEILING * 10]
  for (const n of samples) {
    assert.ok(formatCount(n).length <= 5, `${n} → "${formatCount(n)}" too wide`)
  }
})

test('a count label stays bounded across the whole counter range', () => {
  for (let exponent = 0; exponent <= 15; exponent++) {
    for (const mantissa of [1, 1.5, 4.4, 9.09, 9.99]) {
      const n = Math.floor(mantissa * 10 ** exponent)
      assert.ok(formatCount(n).length <= 5, `${n} → "${formatCount(n)}"`)
    }
  }
})

test('counts below a thousand are shown exactly', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(7), '7')
  assert.equal(formatCount(999), '999')
})

test('counts are abbreviated with one decimal only while it adds precision', () => {
  assert.equal(formatCount(1234), '1.2k')
  assert.equal(formatCount(9950), '9.9k')
  assert.equal(formatCount(44364), '44k')
  assert.equal(formatCount(909141), '909k')
  assert.equal(formatCount(5400000), '5.4M')
})

test('a rounding overflow rolls up to the next unit instead of a wider label', () => {
  assert.equal(formatCount(999999), '1M')
  assert.equal(formatCount(999999999), '1G')
  assert.equal(formatCount(999999999999), '1T')
})

test('a hostile value degrades to zero rather than NaN', () => {
  assert.equal(formatCount(NaN), '0')
  assert.equal(formatCount(-5), '0')
  assert.equal(formatCount(Infinity), '999P+')
  assert.equal(formatCount(undefined), '0')
})

// ─── Saturation ───────────────────────────────────────────────────────────

test('a counter saturates below the float-precision cliff', () => {
  assert.ok(COUNTER_CEILING < Number.MAX_SAFE_INTEGER)
  assert.equal(bumpCounter(COUNTER_CEILING), COUNTER_CEILING)
  assert.equal(bumpCounter(COUNTER_CEILING + 1e9), COUNTER_CEILING)
  // Every value it can hold is still an exactly representable integer.
  assert.ok(Number.isSafeInteger(bumpCounter(COUNTER_CEILING)))
})

test('a counter increments normally in the range anyone will ever see', () => {
  assert.equal(bumpCounter(0), 1)
  assert.equal(bumpCounter(41593), 41594)
  assert.equal(bumpCounter(undefined), 1)
  assert.equal(bumpCounter(NaN), 1)
})

test('a saturated counter is marked as a floor, not an exact total', () => {
  assert.equal(formatCount(COUNTER_CEILING), '999P+')
  assert.ok(formatExact(COUNTER_CEILING).endsWith('+'))
})

// ─── Rates ────────────────────────────────────────────────────────────────

test('a rate is messages per second over the measured window', () => {
  assert.equal(ratePerSecond(1, 500), 2)
  assert.equal(ratePerSecond(60, 1000), 60)
  assert.equal(ratePerSecond(1, 526), 1.9)
})

test('an unmeasurable window yields zero, never Infinity or NaN', () => {
  assert.equal(ratePerSecond(5, 0), 0)
  assert.equal(ratePerSecond(5, -100), 0)
  assert.equal(ratePerSecond(0, 500), 0)
  assert.equal(ratePerSecond(NaN, 500), 0)
  assert.equal(ratePerSecond(5, NaN), 0)
})

test('a counter that did not move reports a zero rate', () => {
  const before = 44364
  const after = 44364
  assert.equal(ratePerSecond(after - before, 500), 0)
  assert.equal(formatRate(0), '0/s')
})

test('a rate label keeps a decimal for slow heartbeats and stays compact when fast', () => {
  assert.equal(formatRate(1.9), '1.9/s')
  assert.equal(formatRate(120), '120/s')
  assert.equal(formatRate(45000), '45k/s')
  assert.ok(formatRate(1e9).length <= 8)
})

test('exact labels carry Turkish thousands separators for the tooltip', () => {
  assert.equal(formatExact(909141), '909.141')
  assert.equal(formatExact(0), '0')
})
