/**
 * Cost math for the DSH cost meter plugin.
 *
 * Pure functions only: no Cordis, no I/O. The Host half folds session events
 * through {@link turnCost}; the Client half only formats what the Host already
 * computed, so both halves agree on one definition of money.
 *
 * DeepSeek bills in CNY per million tokens with three disjoint prompt-side
 * buckets plus one output bucket:
 *   - cache-hit input (prefix cache reused) — cheapest
 *   - cache-miss input (uncached prompt tokens) — full price
 *   - cache-write input — charged at the miss price (no separate published rate)
 *   - output (completion, reasoning tokens included)
 *
 * Peak/off-peak (official schedule, Asia/Shanghai): Mon–Fri 09:00–12:00 and
 * 14:00–18:00 are peak and cost exactly double; every other moment — evenings,
 * weekends, and Chinese statutory holidays — is off-peak.
 */

/** Published per-million-token rates in CNY: [off-peak, peak]. */
const FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
/** `deepseek-v4-pro` is 3x Flash on every bucket (official 2026-08-17 schedule). */
const PRO = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }

/**
 * Built-in rate table. Keys are matched as case-insensitive substrings of the
 * reported model id, longest key first, so `deepseek-v4-flash-vision-exp`
 * resolves to the Flash row and a user row for an exact id always wins.
 */
export const BUILTIN_RATES = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-v4-pro': PRO,
  'deepseek-reasoner': PRO,
  _default: FLASH,
}

/**
 * Statutory Chinese holiday dates that DeepSeek bills at the off-peak rate.
 * Source: State Council 2026 holiday arrangement (国办发明电〔2025〕7 号) plus
 * the official API pricing footnote. Extend every November for the next year.
 */
export const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

const PEAK_WINDOWS = [[9, 12], [14, 18]]

/** Shift a timestamp into the Beijing wall clock and read it in UTC accessors. */
function beijing(time) {
  return new Date(Number(time) + 8 * 3600 * 1000)
}

/** Beijing calendar day (`YYYY-MM-DD`) containing `time`. */
export function beijingDay(time = Date.now()) {
  return beijing(time).toISOString().slice(0, 10)
}

/**
 * Classify one instant against the official peak schedule.
 * @param time epoch milliseconds.
 * @returns `true` for the peak (double-price) window.
 */
export function isPeakTime(time) {
  const at = Number(time)
  if (!Number.isFinite(at)) return false
  const bj = beijing(at)
  const day = bj.toISOString().slice(0, 10)
  if (HOLIDAYS.has(day)) return false
  const weekday = bj.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_WINDOWS) if (hour >= start && hour < end) return true
  return false
}

/**
 * The next instant at which the peak/off-peak classification flips.
 * Only Beijing hour boundaries can flip it, so the scan is cheap and exact.
 * @param time epoch milliseconds to search forward from.
 * @returns epoch milliseconds, or `null` when nothing flips within 14 days.
 */
export function nextPeakChange(time) {
  const from = Number(time)
  if (!Number.isFinite(from)) return null
  const current = isPeakTime(from)
  const dayStart = Math.floor((from + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000
  for (let day = 0; day <= 14; day += 1) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const candidate = dayStart + day * 86400000 + edge * 3600 * 1000
      if (candidate <= from) continue
      if (isPeakTime(candidate) !== current) return candidate
    }
  }
  return null
}

/** Normalize one user- or built-in-supplied rate row into four finite numbers. */
export function normalizeRate(row) {
  const pick = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback)
  const pair = (value, fallback) => {
    if (Array.isArray(value)) return [pick(value[0], fallback[0]), pick(value[1], fallback[1])]
    const flat = pick(value, fallback[0])
    return [flat, flat]
  }
  return { hit: pair(row && row.hit, FLASH.hit), miss: pair(row && row.miss, FLASH.miss), out: pair(row && row.out, FLASH.out) }
}

/**
 * Resolve the rate row for one reported model id.
 * @param model reported provider model id (may be empty or unknown).
 * @param custom optional user rows merged over the built-ins.
 */
export function rateFor(model, custom) {
  const name = String(model || '').toLowerCase()
  const tables = [custom || {}, BUILTIN_RATES]
  for (const table of tables) {
    for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
      if (key === '_default') continue
      if (key && name.includes(String(key).toLowerCase())) return normalizeRate(table[key])
    }
  }
  return normalizeRate(custom && custom._default ? custom._default : BUILTIN_RATES._default)
}

/**
 * Split one usage record into the four billed token buckets.
 *
 * The three prompt-side buckets are **disjoint** in DSH's own accounting: the
 * `tokenUsage` projection declares `uncachedInputTokens: usage.inputTokens`
 * next to `cacheReadTokens` / `cacheWriteTokens` and sums them for the prompt
 * total (`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js`). So
 * `inputTokens` already excludes cache reads and must NOT have them subtracted
 * — doing so would also go negative whenever a long cached prompt is re-sent.
 */
export function tokenBuckets(usage) {
  const count = (value) => Math.max(0, Number(value) || 0)
  return {
    cacheMiss: count(usage && usage.inputTokens),
    cacheRead: count(usage && usage.cacheReadTokens),
    cacheWrite: count(usage && usage.cacheWriteTokens),
    output: count(usage && usage.outputTokens),
  }
}

/**
 * Price one model call.
 * `reasoningTokens` is deliberately absent: DSH guarantees it is a subset of
 * `outputTokens`, so charging it separately would double-bill the output side.
 *
 * @param usage the committed `TokenUsage` (any subset of fields).
 * @param options `{ model, at, peakMode, rates }`.
 * @returns the four costs plus their total, in CNY.
 */
export function turnCost(usage, options = {}) {
  const rate = rateFor(options.model, options.rates)
  const peakMode = options.peakMode === 'always' ? true : options.peakMode === 'never' ? false : isPeakTime(options.at)
  const index = peakMode ? 1 : 0
  const buckets = tokenBuckets(usage)
  const hit = (buckets.cacheRead / 1e6) * rate.hit[index]
  // Cache-write tokens are charged at the miss rate: no separate published rate.
  const miss = ((buckets.cacheMiss + buckets.cacheWrite) / 1e6) * rate.miss[index]
  const out = (buckets.output / 1e6) * rate.out[index]
  return {
    peak: peakMode,
    rate: { hit: rate.hit[index], miss: rate.miss[index], out: rate.out[index] },
    tokens: buckets,
    inputCost: hit + miss,
    cacheHitCost: hit,
    outputCost: out,
    cost: hit + miss + out,
  }
}

/** Format a CNY amount for display at satoshi precision, trimming noise. */
export function formatCny(value) {
  const amount = Number(value) || 0
  if (amount === 0) return '¥0'
  if (amount < 0.0001) return '¥<' + '0.0001'
  const digits = amount < 0.01 ? 4 : amount < 1 ? 3 : 2
  return '¥' + amount.toFixed(digits)
}
