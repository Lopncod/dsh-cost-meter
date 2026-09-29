# dsh-cost-meter

A **cost meter** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web / Desktop: one small ambient pill right under the composer that tells you **what this answer cost** and **what this session has cost so far**.

```
本会话消耗 ¥1.23 · 本次回答 ¥0.087            off-peak · peak in 2h15m
```

English | [中文](README.md)

## What it shows

- **Last answer** — the estimated cost of the most recently completed turn. It refreshes the moment the turn settles and flashes once.
- **Session cost** — the running total for the current session, including the turn still in flight.
- Click the pill for a **per-turn breakdown**: cost per turn, the four token buckets (cache-hit read / cache-miss read / cache write / output), the rates applied to that turn, its peak/off-peak tag, and its step count. When the ledger holds more than one session, the panel also lists every locally recorded session and a grand total.

## Install

Install the bundle with DSH's Plugin Manager:

```
plugin_manager  action: install_bundle  target: <this directory, absolute path, or this repository>
```

or point it straight at the repository:

```
plugin_manager  action: install_bundle  target: github:Lopncod/dsh-cost-meter
```

**DSH must be restarted afterwards.** The Host half is an ESM module imported at startup: editing files or re-enabling the bundle does not reload it (verified locally — a toggle only remounts the same module generation).

## How costs are computed

Estimates use DeepSeek's published CNY-per-million-token rates and its **peak/off-peak** schedule:

| Bucket | Meaning | Flash off-peak / peak | Pro off-peak / peak |
|---|---|---|---|
| Cache-hit read | Prompt tokens served from the prefix cache | 0.02 / 0.04 | 0.15 / 0.30 |
| Cache-miss read | Prompt tokens not in cache | 1 / 2 | 4.5 / 9 |
| Cache write | Prompt tokens written to cache (charged at the miss rate) | 1 / 2 | 4.5 / 9 |
| Output | Completion, reasoning tokens included | 4 / 8 | 13.5 / 27 |

- **Peak** = Asia/Shanghai, **Mon–Fri 09:00–12:00 and 14:00–18:00**. Every other moment — evenings, weekends, and Chinese statutory holidays — is off-peak.
- These are **estimates, not a bill**. The real charge is whatever the balance on the DeepSeek side moved by.

### Token accounting (the load-bearing detail)

All four buckets come from the real `usage` on committed `assistant/message` events — the token counts the model was actually billed for. Nothing is estimated:

- `inputTokens` is the **uncached** bucket and is **disjoint** from `cacheReadTokens` / `cacheWriteTokens`; the three sum to the prompt total. That definition is copied from DSH itself — the `tokenUsage` projection in `@deepseek-ai/dsh-token-meter` calls it `uncachedInputTokens` and adds it to the other two (`lib/types/usage-projection.js`).
- `reasoningTokens` is a subset of `outputTokens` and is **not** charged again, or the output side would be billed twice.
- A repeated settlement for the same `(turn, step)` **replaces** rather than adds to the previous one; only `llm/retry-started` reopens that slot. Same semantics as token-meter's `addReplacing`, so a retry or a second subscription cannot bill one turn twice.

## Configuration (optional)

`$DSH_HOME/.dsh-cost.json` (on Windows, `C:\Users\<you>\.dsh\.dsh-cost.json`). It is re-read on change; no restart needed:

```json
{
  "peakMode": "auto",
  "defaultModel": "deepseek-flash",
  "rates": {
    "my-proxy-flash": { "hit": 0.01, "miss": 0.5, "out": 2 }
  }
}
```

| Field | Meaning |
|---|---|
| `peakMode` | `"auto"` (default, judge peak/off-peak in Beijing time) / `"always"` (price everything at peak, an upper bound) / `"never"` (everything off-peak) |
| `defaultModel` | Model id used to pick a rate row when `request/header` is missing (old logs, non-standard callers) |
| `rates` | Custom rates. Keys are **substrings of the model id**, longest match first, overriding the built-in rows. Values are `{hit, miss, out}` in **CNY per million tokens**; a single number means the same rate at peak and off-peak; the key `_default` replaces the fallback row |

The ledger lives at `$DSH_HOME/.dsh-cost-ledger.json` (per-session, per-turn). Deleting it only loses history; the next event starts accumulating again.

## HTTP surface

The Host half registers a few read-only routes through `ctx.webServer`, readable by any same-origin script:

| Route | Purpose |
|---|---|
| `GET /dsh-cost/state?sessionId=<id>` | Current session + all-session summary + peak state. An unknown `sessionId` falls back to the most recently recorded session and reports `fallback: true` |
| `GET /dsh-cost/rates` | Effective built-in / custom rate table |
| `GET /dsh-cost/debug` | The last 12 `/state` request URLs — answers "is the page asking, and with which identity?" |

DSH's browser auth fence covers only the `/api` channel; plugin routes are unaffected.

## Development

```bash
npm test        # 18 checks: peak boundaries, longest-match rate lookup, real cached-request pricing,
                # replacement semantics, ledger JSON round-trip
```

| File | Responsibility |
|---|---|
| `lib/pricing.js` | Pure pricing layer: peak schedule, rate lookup, bucket split, cost |
| `lib/ledger.js` | Folds session events into per-turn / per-session rows, with `(turn, step)` replacement and the persisted shape |
| `lib/index.js` | Host half: folds `session/event`, persists the ledger, serves the routes |
| `client.js` | Client half: the pill and breakdown panel in the `conversation.composer.dock` slot |

The Client half is a DSH **dynamic client module** (`window.__ModuleLoader__.load({ id, factory })`). It requires `react` from the frozen platform table and no Harness Client package at all; every style is inline and references only `--dsw-alias-*` theme tokens.

## Known limitations

- **Only turns after the plugin was enabled.** The ledger accumulates from the live `session/event` feed; sessions that ran before installation have no history.
- Subagent sessions are recorded per their own `sessionId` rather than folded into the parent row, but they do count toward the grand total.
- A forked / resumed session accumulates only events that happen **in this process**; the copied historical prefix is not billed twice, matching how the provider charges.

## License

[MIT](LICENSE) © Lopncod
