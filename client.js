/**
 * @local/dsh-cost-meter — Client half.
 *
 * Renders one ambient pill below the composer showing what the current session
 * has cost so far, plus what the last finished answer cost. Clicking it opens a
 * per-turn breakdown. All money is computed on the Host half; this module only
 * fetches `/dsh-cost/state` and formats it.
 *
 * The browser module system loads this file as a lazy factory whose id equals
 * the package name; `react` comes from the frozen platform table. Styles are
 * inline so the plugin owns no stylesheet lifecycle and inherits the host
 * theme through `--dsw-alias-*` tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-cost-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const REFRESH_MS = 5000
    const HIGHLIGHT_MS = 12000
    const STATE_URL = '/dsh-cost/state'

    const NS = 'cost-meter'
    const DICT = {
      zh: {
        pill: '本会话消耗',
        pillTitle: '本会话累计消耗，点击查看逐轮明细',
        last: '本次回答',
        turn: '第 {n} 轮',
        session: '本会话',
        sessions: '本机已记账的全部会话',
        total: '合计',
        turns: '轮次',
        cacheHit: '命中率',
        cacheRead: '缓存命中读',
        cacheMiss: '未命中读',
        cacheWrite: '缓存写',
        output: '输出',
        peak: '高峰价',
        valley: '空闲价',
        peakUntil: '高峰计价，{t} 后转空闲',
        valleyUntil: '{t} 后转高峰',
        rate: '单价 ¥/百万',
        empty: '还没有已完成的一轮',
        loading: '读取记账中…',
        unavailable: '暂时读不到记账数据',
        refresh: '刷新',
        priceNote: '按官方峰谷单价估算，非账单金额',
        step: '步',
        welcome: '本会话暂无记账，已显示最近有记录的会话',
        fromOther: '记账来源 {id}',
      },
      en: {
        pill: 'Session cost',
        pillTitle: 'Cost of this session so far; click for the per-turn breakdown',
        last: 'Last answer',
        turn: 'Turn {n}',
        session: 'This session',
        sessions: 'Every local session on the ledger',
        total: 'Total',
        turns: 'Turns',
        cacheHit: 'Hit rate',
        cacheRead: 'Cache-hit read',
        cacheMiss: 'Cache-miss read',
        cacheWrite: 'Cache write',
        output: 'Output',
        peak: 'peak',
        valley: 'off-peak',
        peakUntil: 'Peak pricing, off-peak in {t}',
        valleyUntil: 'Peak pricing in {t}',
        rate: 'CNY / million',
        empty: 'No settled turn yet',
        loading: 'Reading the ledger…',
        unavailable: 'Ledger unavailable',
        refresh: 'Refresh',
        priceNote: 'Estimated from published peak/off-peak rates, not a bill',
        step: 'steps',
        welcome: 'No ledger row for this session yet; showing the most recent one',
        fromOther: 'Ledger row {id}',
      },
    }

    const S = {
      root: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginTop: '6px',
        flexWrap: 'wrap',
        fontSize: '12px',
        lineHeight: 1.4,
        color: 'var(--dsw-alias-label-secondary)',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'inherit',
        borderRadius: '999px',
        padding: '2px 9px',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      pillActive: { borderColor: 'var(--dsw-alias-brand-primary)' },
      strong: {
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      last: { color: 'var(--dsw-alias-brand-primary)', fontVariantNumeric: 'tabular-nums' },
      sep: { opacity: 0.5 },
      small: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      panel: {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 6px)',
        zIndex: 40,
        minWidth: '288px',
        maxWidth: 'min(420px, 90vw)',
        maxHeight: 'min(60vh, 520px)',
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        boxShadow: '0 10px 30px rgba(0,0,0,.22)',
        padding: '10px 12px',
        color: 'var(--dsw-alias-label-primary)',
        textAlign: 'left',
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        paddingBottom: '6px',
        marginBottom: '6px',
      },
      headTitle: { fontWeight: 600 },
      headSub: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '2px 0',
      },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      rowValue: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      detail: {
        margin: '0 0 4px 10px',
        paddingLeft: '8px',
        borderLeft: '2px solid var(--dsw-alias-border-l1)',
      },
      turnHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        marginTop: '8px',
        paddingTop: '6px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontWeight: 600,
      },
      tag: {
        display: 'inline-block',
        borderRadius: '4px',
        padding: '0 5px',
        fontSize: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 400,
      },
      tagPeak: {
        borderColor: 'var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '6px',
        padding: '1px 7px',
        font: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
      },
    }

    /** `¥1.234` with satoshi precision, matching the Host's own formatter intent. */
    function money(value) {
      const amount = Number(value) || 0
      if (amount === 0) return '¥0'
      if (amount < 0.0001) return '¥<0.0001'
      const digits = amount < 0.01 ? 4 : amount < 1 ? 3 : 2
      return '¥' + amount.toFixed(digits)
    }

    function compactTokens(value) {
      const n = Math.max(0, Number(value) || 0)
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k'
      return String(Math.round(n))
    }

    function countdown(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return hours + 'h' + String(minutes).padStart(2, '0') + 'm'
      if (minutes > 0) return minutes + 'm'
      return total + 's'
    }

    function turnTokens(turn) {
      const tokens = (turn && turn.tokens) || {}
      return (tokens.cacheHit || 0) + (tokens.cacheMiss || 0) + (tokens.cacheWrite || 0) + (tokens.output || 0)
    }

    function cacheHitShare(tokens) {
      const billed = (tokens.cacheHit || 0) + (tokens.cacheMiss || 0) + (tokens.cacheWrite || 0)
      if (billed <= 0) return null
      return Math.round(((tokens.cacheHit || 0) / billed) * 100)
    }

    function TokenRows({ t, tokens }) {
      const rows = [
        [t('cacheRead'), tokens.cacheHit],
        [t('cacheMiss'), tokens.cacheMiss],
      ]
      if ((tokens.cacheWrite || 0) > 0) rows.push([t('cacheWrite'), tokens.cacheWrite])
      rows.push([t('output'), tokens.output])
      return h('div', { style: S.detail }, rows.map(([label, value]) => h('div', { key: label, style: S.row },
        h('span', { style: Object.assign({}, S.rowLabel, S.small) }, label),
        h('span', { style: Object.assign({}, S.rowValue, S.small) }, compactTokens(value)))))
    }

    function Panel({ t, data, currency, onRefresh }) {
      const current = data.current
      if (!current) return h('div', { style: S.small }, t('unavailable'))
      const tokens = current.tokens || {}
      const hit = cacheHitShare(tokens)
      const tail = current.turnTail || []
      const all = data.sessions || []
      const children = [
        h('div', { key: 'head', style: S.head },
          h('span', { style: S.headTitle }, t('session')),
          h('span', { style: S.headSub },
            (current.model ? current.model + ' · ' : '') + t('turns') + ' ' + current.turns
            + (hit === null ? '' : ' · ' + t('cacheHit') + ' ' + hit + '%'))),
        h('div', { key: 'total', style: S.row },
          h('span', { style: S.rowLabel }, t('total')),
          h('span', { style: Object.assign({}, S.rowValue, S.strong) }, money(current.total) + ' ' + currency)),
        h(TokenRows, { key: 'tokens', t, tokens }),
      ]
      if (tail.length === 0) {
        children.push(h('div', { key: 'empty', style: S.small }, t('empty')))
      } else {
        for (const turn of tail) {
          children.push(h('div', { key: 'turn-' + turn.turn },
            h('div', { style: S.turnHead },
              h('span', null, t('turn', { n: turn.turn }), ' ',
                h('span', { style: turn.peak ? Object.assign({}, S.tag, S.tagPeak) : S.tag },
                  turn.peak ? t('peak') : t('valley'))),
              h('span', { style: S.rowValue }, money(turn.cost))),
            h('div', { style: S.small },
              compactTokens(turnTokens(turn)) + ' tok · ' + turn.steps + ' ' + t('step')),
            turn.rate
              ? h('div', { style: S.small },
                t('rate') + ': ' + turn.rate.hit + ' / ' + turn.rate.miss + ' / ' + turn.rate.out)
              : null))
        }
      }
      if (all.length > 1) {
        children.push(h('div', { key: 'allHead', style: S.turnHead },
          h('span', null, t('sessions')),
          h('span', { style: S.rowValue }, money(data.grandTotal) + ' ' + currency)))
        for (const row of all.slice(0, 8)) {
          children.push(h('div', { key: 's-' + row.sessionId, style: S.row },
            h('span', { style: Object.assign({}, S.rowLabel, S.small) },
              row.sessionId.slice(0, 8) + '… (' + row.turns + ')'),
            h('span', { style: Object.assign({}, S.rowValue, S.small) }, money(row.total))))
        }
      }
      children.push(h('div', { key: 'foot', style: Object.assign({}, S.row, { marginTop: '8px' }) },
        h('span', { style: Object.assign({}, S.rowLabel, S.small) }, t('priceNote')),
        h('button', { type: 'button', style: S.btn, onClick: () => { onRefresh() } }, t('refresh'))))
      return h('div', null, children)
    }

    function CostPill({ t, sessionId, useSession }) {
      // The session snapshot publishes `running`; a transition to `false` is the
      // exact moment a turn — and its billed usage — has settled.
      const running = useSession ? useSession((snapshot) => snapshot && snapshot.running) : false
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [highlight, setHighlight] = React.useState(null)
      const seenTurn = React.useRef(null)
      const seenRunning = React.useRef(false)
      const alive = React.useRef(true)

      // The session identity is read through a ref so `load` can keep a stable
      // identity: an unstable callback would re-arm every effect below on each
      // render, which turns a polling component into an unbounded request loop.
      const idRef = React.useRef(sessionId)
      idRef.current = sessionId

      const load = React.useCallback((probe) => {
        // An absent session id must still ask: the Host answers with its most
        // recently active session, which beats showing nothing at all.
        const current = idRef.current
        const params = []
        if (typeof current === 'string' && current) params.push('sessionId=' + encodeURIComponent(current))
        // The Client half has no console an operator can read, so a request may
        // report what the seat actually handed over. `/dsh-cost/debug` then
        // answers "is the page asking, and with which identity?".
        if (probe) params.push('probe=' + encodeURIComponent(probe))
        const query = params.length > 0 ? '?' + params.join('&') : ''
        return fetch(STATE_URL + query, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
          .then((payload) => {
            if (!alive.current) return
            setData(payload)
            setError(null)
            const turn = payload && payload.current && payload.current.lastTurn
            if (!turn) return
            const signature = turn.turn + ':' + turn.cost + ':' + turn.lastAt
            if (seenTurn.current === null) { seenTurn.current = signature; return }
            if (seenTurn.current === signature) return
            seenTurn.current = signature
            setHighlight(signature)
          })
          .catch((err) => { if (alive.current) setError(String((err && err.message) || err)) })
      }, [])

      // Mount, and remount when the addressed session changes.
      React.useEffect(() => {
        alive.current = true
        seenTurn.current = null
        seenRunning.current = false
        load('seat:sessionId=' + JSON.stringify(typeof sessionId))
        return () => { alive.current = false }
      }, [sessionId, load])

      // Refetch exactly on the running -> idle edge, where a turn's billed usage
      // has just been committed.
      React.useEffect(() => {
        const next = running === true
        if (seenRunning.current === next) return
        seenRunning.current = next
        if (!next) load()
      }, [running, load])

      React.useEffect(() => {
        const id = setInterval(() => { load() }, REFRESH_MS)
        return () => clearInterval(id)
      }, [load])

      React.useEffect(() => {
        if (highlight === null) return undefined
        const id = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
        return () => clearTimeout(id)
      }, [highlight])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      const current = data && data.current
      if (!current) {
        return h('div', { style: S.root },
          h('span', { style: Object.assign({}, S.pill, S.small) }, error ? t('unavailable') : t('loading')))
      }

      const last = current.lastTurn
      const lastSignature = last ? last.turn + ':' + last.cost + ':' + last.lastAt : null
      const flashing = lastSignature !== null && lastSignature === highlight
      const pillStyle = Object.assign({}, S.pill, open || hover ? S.pillActive : null)

      return h('div', { style: S.root },
        h('button', {
          type: 'button',
          style: pillStyle,
          'aria-expanded': open,
          title: t('pillTitle'),
          onClick: () => setOpen((value) => !value),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h('span', null, t('pill')),
        h('span', { style: S.strong }, money(current.total)),
        last
          ? h(React.Fragment, null,
            h('span', { style: S.sep }, '·'),
            h('span', { style: S.last }, t('last') + ' ' + money(last.cost) + (flashing ? ' ●' : '')))
          : null),
        h('span', { style: S.small },
          data.peak ? t('peak') + ' ×2' : t('valley'),
          data.nextPeakChangeAt
            ? ' · ' + t(data.peak ? 'peakUntil' : 'valleyUntil', { t: countdown(data.nextPeakChangeAt - data.now) })
            : '',
          current.fallback
            ? ' · ' + t('fromOther', { id: String(current.sessionId || '').slice(0, 8) + '…' })
            : ''),
        open
          ? h('div', { style: S.panel, role: 'dialog', 'aria-label': t('pill') },
            h(Panel, { t, data, currency: data.currency || 'CNY', onRefresh: load }))
          : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'cost-meter: locale')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost-meter',
          order: 20,
          locale: NS,
        }, CostPill))
      },
    }
  },
})
