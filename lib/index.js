/**
 * @local/dsh-cost-meter — Host half.
 *
 * Folds every committed session event into a per-session cost ledger and
 * serves it to the Client half (and to anything else on the loopback Web
 * origin) as small JSON documents. The Client half renders the pill; this half
 * owns the money.
 *
 * Data sources, all confirmed against the running Harness:
 *   - `session/event` (emit) carries every committed `SessionEvent`, including
 *     `assistant/message` with its billed `usage` and `request/header` with the
 *     frozen model configuration.
 *   - `webserver/index-inject` is not used: the Client half is a normal
 *     `dsh.client` bundle, so `dsh-client-modules` serves it.
 *
 * Configuration lives in `$DSH_HOME/.dsh-cost.json` and is re-read on change:
 *
 *   {
 *     "peakMode": "auto" | "always" | "never",
 *     "rates": { "my-model-id": { "hit": 0.02, "miss": 1, "out": 4 } },
 *     "defaultModel": "deepseek-flash"
 *   }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isPeakTime, nextPeakChange, rateFor, turnCost, BUILTIN_RATES } from './pricing.js'
import {
  createLedger, foldEvent, restoreLedger, sessionTokens, sessionTotal, sessionTurns,
} from './ledger.js'

/** Services this plugin needs before it can serve anything. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-cost'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LEDGER_FILE = path.join(DSH_HOME, '.dsh-cost-ledger.json')
const CONFIG_FILE = path.join(DSH_HOME, '.dsh-cost.json')
const SAVE_DEBOUNCE_MS = 1500
const MAX_SESSIONS = 400
const TURN_TAIL = 40

const DEFAULT_CONFIG = { peakMode: 'auto', rates: {}, defaultModel: '' }

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG }
    return {
      peakMode: raw.peakMode === 'always' || raw.peakMode === 'never' ? raw.peakMode : 'auto',
      rates: raw.rates && typeof raw.rates === 'object' ? raw.rates : {},
      defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
    }
  } catch (err) {
    return { ...DEFAULT_CONFIG }
  }
}

function readLedgerFile() {
  try {
    return restoreLedger(JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')))
  } catch (err) {
    return createLedger()
  }
}

/** Keep the newest records so the file stays bounded. */
function prune(ledger) {
  const ids = Object.keys(ledger.sessions)
  if (ids.length <= MAX_SESSIONS) return
  ids
    .sort((a, b) => (ledger.sessions[b].updatedAt || 0) - (ledger.sessions[a].updatedAt || 0))
    .slice(MAX_SESSIONS)
    .forEach((id) => { delete ledger.sessions[id] })
}

/** One turn row as the Client renders it. */
function turnRow(turn) {
  return {
    turn: turn.turn,
    steps: turn.steps,
    cost: turn.cost,
    model: turn.model || '',
    peak: !!turn.peak,
    tokens: turn.tokens,
    startedAt: turn.startedAt,
    lastAt: turn.lastAt,
  }
}

export function apply(ctx) {
  let config = readConfig()
  let ledger = readLedgerFile()
  let saveTimer = null
  let dirty = false

  const cost = (usage, options) => turnCost(usage, {
    model: options.model || config.defaultModel,
    at: options.at,
    peakMode: config.peakMode,
    rates: config.rates,
  })

  function save() {
    saveTimer = null
    if (!dirty) return
    dirty = false
    prune(ledger)
    try {
      fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger))
    } catch (err) {
      ctx.logger.warn(`cost-meter: cannot write ${LEDGER_FILE}: ${err && err.message}`)
    }
  }

  function scheduleSave() {
    dirty = true
    if (saveTimer !== null) return
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  // ---- Live fold ---------------------------------------------------------
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const id = session && session.id
    if (!id || !event) return
    let changed = false
    try {
      changed = foldEvent(ledger, id, event, cost)
    } catch (err) {
      ctx.logger.warn(`cost-meter: fold failed for ${id}: ${err && err.message}`)
      return
    }
    if (changed) scheduleSave()
  }), 'cost-meter: session cost fold')

  // ---- Config reload -----------------------------------------------------
  ctx.effect(() => {
    let watcher = null
    try {
      watcher = fs.watch(CONFIG_FILE, () => { config = readConfig() })
      if (typeof watcher.unref === 'function') watcher.unref()
    } catch (err) { /* the file need not exist yet */ }
    return () => { try { if (watcher) watcher.close() } catch (err) {} }
  }, 'cost-meter: config watch')

  ctx.effect(() => () => {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
    dirty = true
    save()
  }, 'cost-meter: ledger flush')

  // ---- HTTP surface ------------------------------------------------------
  function state(sessionId) {
    const now = Date.now()
    const peak = config.peakMode === 'always' ? true : config.peakMode === 'never' ? false : isPeakTime(now)
    const ids = Object.keys(ledger.sessions)
    let grandTotal = 0
    const sessions = []
    for (const id of ids) {
      const record = ledger.sessions[id]
      const total = sessionTotal(record)
      grandTotal += total
      sessions.push({
        sessionId: id,
        total,
        turns: sessionTurns(record).length,
        model: record.model || '',
        updatedAt: record.updatedAt,
      })
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    // The page addresses the current session by its durable id. When that id is
    // not on the ledger — a session whose turns all predate this installation, a
    // forked child, or a host that keyed the fold differently — fall back to the
    // most recently active record instead of reporting nothing, and say which
    // session the numbers belong to so the UI never silently mislabels them.
    const requestedId = typeof sessionId === 'string' ? sessionId.trim() : ''
    let record = requestedId ? ledger.sessions[requestedId] : undefined
    let resolvedId = record ? requestedId : ''
    let fallback = false
    if (!record && sessions.length > 0) {
      resolvedId = sessions[0].sessionId
      record = ledger.sessions[resolvedId]
      fallback = true
    }

    const turns = sessionTurns(record)
    const current = record
      ? {
        sessionId: resolvedId,
        requestedSessionId: requestedId,
        fallback,
        total: sessionTotal(record),
        tokens: sessionTokens(record),
        turns: turns.length,
        model: record.model || config.defaultModel || '',
        lastTurn: record.lastTurn ? turnRow(record.lastTurn) : null,
        turnTail: turns.slice(-TURN_TAIL).reverse().map(turnRow),
        activeTurn: record.pending ? turnRow(record.pending) : null,
      }
      : null

    return {
      ok: true,
      now,
      currency: 'CNY',
      peak,
      peakMode: config.peakMode,
      nextPeakChangeAt: nextPeakChange(now),
      current,
      sessions,
      grandTotal,
      ledgerVersion: ledger.version,
      knownModels: Object.keys(BUILTIN_RATES).filter((key) => key !== '_default'),
    }
  }

  function send(res, body, status = 200) {
    try {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    } catch (err) { /* the peer may already be gone */ }
  }

  /**
   * Last few `/state` calls, newest first. The Client half cannot report errors
   * anywhere an operator can see them, so the request log is the only way to
   * tell "the page is not asking" from "the page is asking for the wrong
   * session" while debugging the pill.
   */
  const requests = []
  function noteRequest(url) {
    requests.unshift({ at: Date.now(), url: String(url || '') })
    if (requests.length > 12) requests.length = 12
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      if (route === '/' || route === '/state') {
        const pageId = url.searchParams.get('sessionId') || ''
        const probe = url.searchParams.get('probe') || ''
        noteRequest(url.pathname + url.search + (probe ? ' | probe=' + probe : ''))
        send(res, state(pageId))
        return
      }
      if (route === '/rates') {
        send(res, { ok: true, builtin: BUILTIN_RATES, custom: config.rates, peakMode: config.peakMode })
        return
      }
      if (route === '/debug') {
        send(res, {
          ok: true,
          requests,
          ledgerSessions: Object.keys(ledger.sessions),
          config,
          routePrefix: ROUTE_PREFIX,
          now: Date.now(),
        })
        return
      }
      send(res, { ok: false, error: 'not-found' }, 404)
    },
  }), 'cost-meter: HTTP routes')

  ctx.logger.info(`cost-meter: serving ${ROUTE_PREFIX}/state (ledger: ${Object.keys(ledger.sessions).length} session(s))`)
}
