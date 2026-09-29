/**
 * Local checks for the cost-meter host half. Run with the bundled Node:
 *   node plugins/dsh-cost-meter/test/fold.test.mjs
 */
import assert from 'node:assert/strict'

import {
  beijingDay, isPeakTime, nextPeakChange, rateFor, tokenBuckets, turnCost, formatCny,
} from '../lib/pricing.js'
import {
  createLedger, foldEvent, restoreLedger, sessionTokens, sessionTotal, sessionTurns,
} from '../lib/ledger.js'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push(['ok', name])
  } catch (err) {
    results.push(['FAIL', name + ' :: ' + (err && err.message)])
  }
}

// ---- peak / off-peak -------------------------------------------------------
// 2026-09-30 is a Wednesday. 10:00 Beijing = 02:00 UTC.
const wed10 = Date.UTC(2026, 8, 30, 2, 0, 0)
// 20:00 Beijing = 12:00 UTC.
const wed20 = Date.UTC(2026, 8, 30, 12, 0, 0)
// 2026-10-03 is a Saturday.
const sat10 = Date.UTC(2026, 9, 3, 2, 0, 0)
// 2026-10-01 is a statutory holiday (Thursday).
const holiday10 = Date.UTC(2026, 9, 1, 2, 0, 0)

test('peak windows and weekends', () => {
  assert.equal(beijingDay(wed10), '2026-09-30')
  assert.equal(isPeakTime(wed10), true)
  assert.equal(isPeakTime(wed20), false)
  assert.equal(isPeakTime(sat10), false)
  assert.equal(isPeakTime(holiday10), false)
  // 12:00-14:00 lunch gap is off-peak on both sides.
  assert.equal(isPeakTime(Date.UTC(2026, 8, 30, 4, 0, 0)), false)
  assert.equal(isPeakTime(Date.UTC(2026, 8, 30, 5, 30, 0)), false)
})

test('nextPeakChange lands on a real boundary', () => {
  const next = nextPeakChange(wed10)
  assert.equal(beijingDay(next), '2026-09-30')
  assert.equal(new Date(next + 8 * 3600e3).toISOString().slice(11, 16), '12:00')
  assert.equal(isPeakTime(next), false)
  const fromValley = nextPeakChange(wed20)
  assert.equal(isPeakTime(fromValley), true)
})

// ---- rates -----------------------------------------------------------------
test('rate table resolves by longest matching key', () => {
  assert.deepEqual(rateFor('deepseek-flash'), { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
  assert.deepEqual(rateFor('deepseek-v4-pro'), { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] })
  assert.deepEqual(rateFor('unknown-model'), { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
  assert.deepEqual(
    rateFor('deepseek-v4-flash-vision-exp'),
    { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  )
  // A user row wins over the built-in table, including a scalar shorthand.
  assert.deepEqual(rateFor('my-proxy-flash', { 'proxy-flash': { hit: 0.01, miss: 0.5, out: 2 } }),
    { hit: [0.01, 0.01], miss: [0.5, 0.5], out: [2, 2] })
})

// ---- token buckets ---------------------------------------------------------
test('prompt-side buckets are disjoint, as DSH token-meter declares them', () => {
  // `inputTokens` is the UNCACHED bucket: the tokenUsage projection names it
  // `uncachedInputTokens` and sums it with the cache buckets for the prompt.
  assert.deepEqual(tokenBuckets({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }),
    { cacheRead: 900, cacheMiss: 100, cacheWrite: 0, output: 50 })
  // A long cached prompt re-sent must not drive the miss bucket negative.
  assert.deepEqual(tokenBuckets({ inputTokens: 684, cacheReadTokens: 520704, outputTokens: 802 }),
    { cacheRead: 520704, cacheMiss: 684, cacheWrite: 0, output: 802 })
  assert.deepEqual(tokenBuckets(undefined), { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 })
  assert.deepEqual(tokenBuckets({ inputTokens: -5, outputTokens: '12' }),
    { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 12 })
})

// ---- cost ------------------------------------------------------------------
test('off-peak flash pricing is exact', () => {
  const summary = turnCost(
    { inputTokens: 100_000, cacheReadTokens: 1_000_000, outputTokens: 250_000 },
    { model: 'deepseek-flash', at: wed20 },
  )
  // 1M hit @0.02 + 0.1M miss @1 + 0.25M out @4 = 0.02 + 0.1 + 1 = 1.12
  assert.equal(Number(summary.cost.toFixed(6)), 1.12)
  assert.equal(summary.peak, false)
  assert.equal(summary.cacheHitCost.toFixed(4), '0.0200')
  assert.equal(summary.outputCost.toFixed(4), '1.0000')
})

test('a real cached request prices sanely', () => {
  // Shape observed from this plugin's own first live ledger row.
  const summary = turnCost(
    { inputTokens: 684, outputTokens: 802, cacheReadTokens: 520_704, cacheWriteTokens: 0 },
    { model: 'deepseek-flash', at: wed20 },
  )
  assert.equal(Number(summary.cost.toFixed(9)), Number((0.01041408 + 0.000684 + 0.003208).toFixed(9)))
})

test('peak pricing doubles the same request', () => {
  const usage = { inputTokens: 100_000, cacheReadTokens: 1_000_000, outputTokens: 250_000 }
  const valley = turnCost(usage, { model: 'deepseek-flash', at: wed20 })
  const peak = turnCost(usage, { model: 'deepseek-flash', at: wed10 })
  assert.equal(peak.peak, true)
  assert.equal(Number(peak.cost.toFixed(6)), Number((valley.cost * 2).toFixed(6)))
})

test('peakMode overrides the clock', () => {
  const usage = { inputTokens: 0, outputTokens: 1_000_000 }
  assert.equal(Number(turnCost(usage, { model: 'deepseek-flash', at: wed20, peakMode: 'always' }).cost.toFixed(4)), 8)
  assert.equal(Number(turnCost(usage, { model: 'deepseek-flash', at: wed10, peakMode: 'never' }).cost.toFixed(4)), 4)
})

test('pro costs three times flash on matched token buckets', () => {
  const usage = { inputTokens: 0, outputTokens: 4_000_000 }
  const flash = turnCost(usage, { model: 'deepseek-flash', at: wed20 })
  const pro = turnCost(usage, { model: 'deepseek-v4-pro', at: wed20 })
  assert.equal(Number(flash.cost.toFixed(4)), 16)
  assert.equal(Number(pro.cost.toFixed(4)), 54)
})

// ---- ledger fold -----------------------------------------------------------
const cost = (usage, options) => turnCost(usage, options)

function feed(ledger, id, events) {
  for (const event of events) foldEvent(ledger, id, event, cost)
  return ledger
}

test('a full turn folds into a settled turn', () => {
  const ledger = createLedger()
  feed(ledger, 's1', [
    { type: 'turn/start', seq: 1, time: wed20, data: { turn: 1 } },
    { type: 'request/header', seq: 2, time: wed20, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 200 } } },
    { type: 'assistant/message', seq: 4, time: wed20, data: { turn: 1, step: 2, usage: { inputTokens: 100, cacheReadTokens: 1900, outputTokens: 100 } } },
    { type: 'turn/end', seq: 5, time: wed20, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const record = ledger.sessions.s1
  assert.equal(record.model, 'deepseek-flash')
  assert.equal(sessionTurns(record).length, 1)
  assert.equal(record.pending, null)
  assert.equal(record.turns[0].steps, 2)
  assert.deepEqual(record.turns[0].tokens, { cacheRead: 2700, cacheMiss: 300, cacheWrite: 0, output: 300 })
  // 2700 @0.02 + 300 @1 + 300 @4, per million = 0.000054 + 0.0003 + 0.0012
  assert.equal(Number(record.turns[0].cost.toFixed(9)), 0.001554)
  assert.equal(Number(sessionTotal(record).toFixed(9)), 0.001554)
  assert.deepEqual(record.lastTurn.turn, 1)
})

test('a re-settled (turn, step) replaces instead of double-billing', () => {
  const ledger = createLedger()
  feed(ledger, 's7', [
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
    // The same settlement observed again through a second subscription/context.
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
  ])
  const pending = ledger.sessions.s7.pending
  assert.equal(pending.steps, 1)
  assert.equal(Number(pending.cost.toFixed(4)), 4)
  assert.deepEqual(pending.tokens, { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 1_000_000 })
  // A streamed settlement that grew within the same step replaces, not adds.
  feed(ledger, 's7', [
    { type: 'assistant/message', seq: 2, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_500_000 } } },
  ])
  assert.equal(ledger.sessions.s7.pending.steps, 1)
  assert.equal(Number(ledger.sessions.s7.pending.cost.toFixed(4)), 6)
  assert.equal(ledger.sessions.s7.pending.usage.outputTokens, 1_500_000)
})

test('llm/retry-started reopens a replaced step', () => {
  const ledger = createLedger()
  feed(ledger, 's8', [
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
    { type: 'llm/retry-started', seq: 2, time: wed20, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
  ])
  const pending = ledger.sessions.s8.pending
  assert.equal(pending.steps, 2)
  assert.equal(Number(pending.cost.toFixed(4)), 8)
})

test('an open turn is included in the running total', () => {
  const ledger = createLedger()
  feed(ledger, 's2', [
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
  ])
  const record = ledger.sessions.s2
  assert.equal(record.turns.length, 0)
  assert.equal(record.pending.turn, 1)
  assert.equal(Number(sessionTotal(record).toFixed(4)), 4)
  assert.equal(sessionTurns(record).length, 1)
})

test('a turn without turn/end settles when the next one opens', () => {
  const ledger = createLedger()
  feed(ledger, 's3', [
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1, usage: { outputTokens: 1_000_000 } } },
    { type: 'assistant/message', seq: 2, time: wed20, data: { turn: 2, step: 1, usage: { outputTokens: 500_000 } } },
  ])
  const record = ledger.sessions.s3
  assert.equal(record.turns.length, 1)
  assert.equal(record.turns[0].turn, 1)
  assert.equal(record.pending.turn, 2)
  assert.equal(Number(sessionTotal(record).toFixed(4)), 6)
})

test('unrecognized events are ignored', () => {
  const ledger = createLedger()
  assert.equal(foldEvent(ledger, 's4', { type: 'tool/result', seq: 1, time: wed20, data: {} }, cost), false)
  assert.equal(foldEvent(ledger, 's4', null, cost), false)
  assert.deepEqual(Object.keys(ledger.sessions), [])
})

test('an empty assistant message records a turn with no cost', () => {
  const ledger = createLedger()
  feed(ledger, 's5', [
    { type: 'assistant/message', seq: 1, time: wed20, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 2, time: wed20, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const record = ledger.sessions.s5
  assert.equal(record.turns.length, 1)
  assert.equal(record.pending, null)
  assert.equal(record.turns[0].cost, 0)
  assert.equal(record.turns[0].steps, 1)
  assert.equal(sessionTotal(record), 0)
  assert.deepEqual(sessionTokens(record), { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 })
})

test('a ledger round-trips through JSON', () => {
  const ledger = createLedger()
  feed(ledger, 's6', [
    { type: 'request/header', seq: 1, time: wed20, data: { header: { config: { model: 'deepseek-v4-pro' } } } },
    { type: 'assistant/message', seq: 2, time: wed20, data: { turn: 1, step: 1, usage: { inputTokens: 10_000, outputTokens: 5_000 } } },
    { type: 'turn/end', seq: 3, time: wed20, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const restored = restoreLedger(JSON.parse(JSON.stringify(ledger)))
  const record = restored.sessions.s6
  assert.equal(record.model, 'deepseek-v4-pro')
  assert.equal(sessionTotal(record), sessionTotal(ledger.sessions.s6))
  assert.deepEqual(sessionTokens(record), sessionTokens(ledger.sessions.s6))
  assert.deepEqual(sessionTurns(record).length, 1)
  assert.deepEqual(restoreLedger({ version: 1, sessions: { old: { turns: [] } } }).sessions, {})
  assert.deepEqual(restoreLedger(null).sessions, {})
})

test('money formatting', () => {
  assert.equal(formatCny(0), '¥0')
  assert.equal(formatCny(0.001554), '¥0.0016')
  assert.equal(formatCny(1.2), '¥1.20')
  assert.equal(formatCny(12.345), '¥12.35')
})

const failed = results.filter(([status]) => status === 'FAIL')
for (const [status, name] of results) console.log(status.padEnd(5), name)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)
