/**
 * Per-session cost ledger for the DSH cost meter plugin.
 *
 * The fold is a pure function of committed session events, so the same code
 * serves the live `session/event` feed and a replay of a stored log. Every
 * mutable field is plain JSON: the ledger is persisted as one file and must
 * survive a format round-trip.
 */

/** Ledger schema version; bump when the fold's fields or semantics change. */
export const LEDGER_VERSION = 2

/** Create an empty ledger. */
export function createLedger() {
  return { version: LEDGER_VERSION, sessions: {} }
}

/** Create one empty session record. */
function emptySession(id, at) {
  return {
    id,
    createdAt: Number(at) || 0,
    updatedAt: Number(at) || 0,
    model: '',
    turns: [],
    pending: null,
    /** Last `(turn, step)` settlement applied, so a repeat replaces it. */
    lastSample: null,
    totalCost: 0,
    totalTokens: ZERO_TOKENS(),
  }
}

function sessionOf(ledger, id, at) {
  let record = ledger.sessions[id]
  if (!record) {
    record = ledger.sessions[id] = emptySession(id, at)
    record.createdAt = Number(at) || 0
  }
  return record
}

function addTokens(target, tokens) {
  target.cacheRead += tokens.cacheRead || 0
  target.cacheMiss += tokens.cacheMiss || 0
  target.cacheWrite += tokens.cacheWrite || 0
  target.output += tokens.output || 0
}

/** Add or remove one token bucket set, so a replaced sample nets out exactly. */
function subtractTokens(target, tokens) {
  target.cacheRead -= tokens.cacheRead || 0
  target.cacheMiss -= tokens.cacheMiss || 0
  target.cacheWrite -= tokens.cacheWrite || 0
  target.output -= tokens.output || 0
}

/** Signed usage delta; used to keep raw per-step totals in sync under replacement. */
function usageDelta(previous, next) {
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  const delta = {}
  for (const key of keys) {
    delta[key] = Math.max(0, Number(next && next[key]) || 0) - Math.max(0, Number(previous && previous[key]) || 0)
  }
  return delta
}

function applyUsageDelta(target, delta) {
  for (const key of Object.keys(delta)) target[key] = Math.max(0, (target[key] || 0) + delta[key])
}

const ZERO_TOKENS = () => ({ cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 })

/**
 * Fold one committed session event into the ledger.
 *
 * Recognized events: `request/header` (model), `assistant/message` (billed
 * usage) and `turn/end` (turn settlement). Everything else is ignored and the
 * ledger is returned unchanged, so a caller can cheaply skip a rebuild.
 *
 * The usage fold mirrors `@deepseek-ai/dsh-token-meter`'s `tokenUsage`
 * projection: one settlement is keyed by `(turn, step)`, and a later event for
 * a key already seen **replaces** it instead of adding to it (a retried or
 * re-settled attempt must not be billed twice). `llm/retry-started` closes the
 * replacement slot for its `(turn, step)`, so a genuine retry adds again.
 *
 * @param ledger mutable ledger (persisted shape).
 * @param sessionId the owning session.
 * @param event one committed `SessionEvent` (or an equivalent replay record).
 * @param cost pure cost function `(usage, { model, at }) => { cost, tokens, rate, peak }`.
 * @returns `true` when the ledger changed.
 */
export function foldEvent(ledger, sessionId, event, cost) {
  if (!event || typeof event !== 'object') return false
  const type = event.type
  if (type !== 'request/header' && type !== 'assistant/message' && type !== 'llm/retry-started' && type !== 'turn/end') return false
  const at = Number(event.time) || Date.now()
  const data = event.data || {}
  const record = sessionOf(ledger, sessionId, at)
  record.updatedAt = Math.max(record.updatedAt, at)

  if (type === 'request/header') {
    const model = data.header && data.header.config && data.header.config.model
    // The header owns the model for the requests that follow it. A subscription
    // can be observed from several contexts, so a repeat reports `true` without
    // changing anything: the caller only needs to know it may re-read state.
    if (typeof model === 'string' && model && model !== record.model) record.model = model
    return true
  }

  if (type === 'llm/retry-started') {
    if (record.lastSample && record.lastSample.turn === Number(data.turn) && record.lastSample.step === Number(data.step)) {
      record.lastSample = null
    }
    return true
  }

  if (type === 'assistant/message') {
    const summary = cost(data.usage, { model: record.model, at })
    const turn = Number(data.turn) || 0
    const step = Number(data.step) || 0
    if (!record.pending || record.pending.turn !== turn) {
      // A turn can lose its `turn/end` (crash, fork, resume): settle the open
      // one into the list so its cost is never silently dropped.
      if (record.pending) finalizePending(record)
      record.pending = newTurn(turn, at)
      record.lastSample = null
    }
    const pending = record.pending
    const previous = record.lastSample && record.lastSample.turn === turn && record.lastSample.step === step
      ? record.lastSample
      : null
    if (previous) {
      // Same settlement seen again: undo it before applying the newer sample.
      pending.cost = Math.max(0, pending.cost - previous.cost)
      subtractTokens(pending.tokens, previous.tokens)
      applyUsageDelta(pending.usage, usageDelta(previous.usage, data.usage || {}))
    } else {
      pending.steps += 1
      applyUsageDelta(pending.usage, usageDelta(null, data.usage || {}))
    }
    pending.lastAt = at
    pending.cost += summary.cost
    pending.peak = summary.peak
    pending.rate = summary.rate
    pending.model = record.model
    addTokens(pending.tokens, summary.tokens)
    record.lastSample = {
      turn,
      step,
      cost: summary.cost,
      tokens: summary.tokens,
      usage: data.usage || {},
    }
    return true
  }

  // turn/end
  if (record.pending && record.pending.turn === Number(data.turn)) {
    finalizePending(record)
    record.lastSample = null
  }
  return true
}

function newTurn(turn, at) {
  return {
    turn,
    startedAt: at,
    lastAt: at,
    steps: 0,
    cost: 0,
    peak: false,
    model: '',
    rate: null,
    tokens: ZERO_TOKENS(),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }
}

/** Settle the open turn into the finished list and update the running totals. */
function finalizePending(record) {
  const pending = record.pending
  if (!pending) return
  record.pending = null
  record.lastSample = null
  record.turns.push(pending)
  if (record.turns.length > 4000) record.turns.splice(0, record.turns.length - 4000)
  record.totalCost += pending.cost
  addTokens(record.totalTokens, pending.tokens)
  record.lastTurn = { turn: pending.turn, cost: pending.cost, tokens: pending.tokens, at: pending.lastAt }
}

/**
 * Replace the ledger's session table with a shallow-restored one.
 * Unknown or malformed rows are dropped rather than trusted.
 * @param raw parsed JSON from the ledger file.
 */
export function restoreLedger(raw) {
  const ledger = createLedger()
  if (!raw || typeof raw !== 'object' || raw.version !== LEDGER_VERSION || !raw.sessions) return ledger
  for (const [id, value] of Object.entries(raw.sessions)) {
    if (!value || typeof value !== 'object') continue
    const record = emptySession(id, value.createdAt)
    record.updatedAt = Number(value.updatedAt) || record.createdAt
    record.model = typeof value.model === 'string' ? value.model : ''
    record.turns = Array.isArray(value.turns)
      ? value.turns
        .filter((turn) => turn && typeof turn === 'object')
        .map((turn) => Object.assign(turn, { tokens: Object.assign(ZERO_TOKENS(), turn.tokens) }))
      : []
    record.pending = value.pending && typeof value.pending === 'object'
      ? Object.assign(value.pending, { tokens: Object.assign(ZERO_TOKENS(), value.pending.tokens) })
      : null
    // `lastSample` is process-local replacement bookkeeping: a restored ledger
    // starts a fresh sample window rather than trusting a persisted slot.
    record.lastSample = null
    record.totalCost = 0
    record.totalTokens = ZERO_TOKENS()
    for (const turn of record.turns) {
      record.totalCost += Number(turn.cost) || 0
      addTokens(record.totalTokens, turn.tokens)
    }
    const last = record.turns[record.turns.length - 1]
    if (last) record.lastTurn = { turn: last.turn, cost: last.cost, tokens: last.tokens, at: last.lastAt }
    ledger.sessions[id] = record
  }
  return ledger
}

/** Total cost including the still-open turn. */
export function sessionTotal(record) {
  if (!record) return 0
  return record.totalCost + (record.pending ? Number(record.pending.cost) || 0 : 0)
}

/** Total tokens including the still-open turn. */
export function sessionTokens(record) {
  const total = ZERO_TOKENS()
  if (!record) return total
  addTokens(total, record.totalTokens || total)
  if (record.pending) addTokens(total, record.pending.tokens || total)
  return total
}

/** Finished turns plus the open one, oldest first. */
export function sessionTurns(record) {
  if (!record) return []
  return record.pending ? [...record.turns, record.pending] : [...record.turns]
}
