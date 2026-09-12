// ─── Message counters — bounded value, bounded width ─────────────────────
//
// Every device card carries a lifetime message counter. The rig runs for days
// at a time and a hand-tracking device can stream hundreds of messages per
// second, so both the NUMBER and its RENDERED WIDTH have to stay bounded:
//
//   - the number saturates below the float-precision cliff, so a counter left
//     running for months never drifts into imprecise arithmetic;
//   - the label is formatted compactly (max 5 glyphs: "999", "9.9k", "44k",
//     "909k", "5.4M"), so a growing count can never widen a card row and push
//     the controls off a narrow layout.
//
// The exact value stays available for tooltips via formatExact().

/**
 * Saturation ceiling for display counters: 1e15, two orders of magnitude below
 * Number.MAX_SAFE_INTEGER (~9.007e15). At a sustained 10 000 msg/s a counter
 * would need ~3 million years to reach it, so in practice this is a proof that
 * the value is bounded rather than a limit anyone will observe.
 */
export const COUNTER_CEILING = 1e15

/**
 * Increment a display counter without ever leaving the exact-integer range.
 * @param {number} current
 * @returns {number}
 */
export function bumpCounter(current) {
  if (current === Infinity) return COUNTER_CEILING
  const n = Number.isFinite(current) ? current : 0
  return n >= COUNTER_CEILING ? COUNTER_CEILING : n + 1
}

const UNITS = [
  { limit: 1e15, suffix: 'P' },
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'G' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'k' }
]

/**
 * Compact, fixed-width-ish count label. Never longer than 5 characters.
 *   999 → "999"   1234 → "1.2k"   44364 → "44k"   909141 → "909k"
 *   5_400_000 → "5.4M"   1e15 → "999P+"
 * @param {number} value
 * @returns {string}
 */
export function formatCount(value) {
  // A corrupt +Infinity is reported as "too large to show", not as zero — the
  // one thing worse than an unreadable counter is a counter that lies quiet.
  if (value === Infinity) return '999P+'
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  if (n >= COUNTER_CEILING) return '999P+'
  if (n < 1000) return String(n)
  for (let i = 0; i < UNITS.length; i++) {
    const { limit, suffix } = UNITS[i]
    if (n < limit) continue
    const scaled = n / limit
    // One decimal only while it buys precision: 9.9k but 44k, 909k.
    if (scaled < 10) return `${trimZero(scaled.toFixed(1))}${suffix}`
    const rounded = Math.round(scaled)
    // 999_999_999 scaled into "M" rounds to 1000 — roll it up to "1G" instead
    // of letting the label grow a digit.
    if (rounded >= 1000 && i > 0) {
      const next = UNITS[i - 1]
      return `${trimZero((n / next.limit).toFixed(1))}${next.suffix}`
    }
    return `${rounded}${suffix}`
  }
  return String(n)
}

/**
 * Compact per-second rate label. Sub-10 rates keep a decimal so an idle
 * heartbeat reads "1.9/s" instead of collapsing to "2/s".
 * @param {number} value messages per second
 * @returns {string}
 */
export function formatRate(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0
  if (n === 0) return '0/s'
  if (n < 10) return `${trimZero(n.toFixed(1))}/s`
  return `${formatCount(Math.round(n))}/s`
}

/**
 * Exact count with locale thousands separators, for tooltips.
 * @param {number} value
 * @returns {string}
 */
export function formatExact(value) {
  if (value === Infinity) return `${COUNTER_CEILING.toLocaleString('tr-TR')}+`
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const label = n.toLocaleString('tr-TR')
  return n >= COUNTER_CEILING ? `${label}+` : label
}

/**
 * Messages per second from a counter delta over a measured window, rounded to
 * one decimal so an idle heartbeat reads 1.9 rather than 1.8999999999999999.
 * A non-positive or unmeasurable window yields 0 — never Infinity or NaN.
 * @param {number} delta counter increase during the window
 * @param {number} elapsedMs window length in milliseconds
 * @returns {number}
 */
export function ratePerSecond(delta, elapsedMs) {
  if (!Number.isFinite(delta) || delta <= 0) return 0
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.round((delta * 1000) / elapsedMs * 10) / 10
}

function trimZero(text) {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}
