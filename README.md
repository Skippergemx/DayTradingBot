# DayTradingBot

Real-time crypto trading desk — research-validated day-trading strategies wired into a live
dashboard (Vortex.Zen interface over 41 USDT pairs, Binance feeds, paper-execution tracker).

## The desks

Three deterministic engines, selectable in the UI — all intraday, flat within the day. The two
**day desks** are this project's focus — designed, swept and validated in the research lab
(`scripts/research-day.mjs`), then ported line-for-line into `src/lib/daydesk.js`:

| Selector | Strategy | Entry | Exits |
|---|---|---|---|
| **Day Breakout** | 15m NR7 compression → 1m close through the bucket high (strong close, 1.5× volume), gated by BTC 1h uptrend + BTC daily > SMA10 | market, 2 bp slip baked in | static 2–2.5×ATR stop · 4R limit target · 12h time stop |
| **Day Cap** | 15m RSI(2) < 2 capitulation flush (1.5× volume) in a gated BTC uptrend, 6h per-symbol cooldown | market, 2 bp slip baked in | 2.5×ATR stop · peak-ratchet trail (arms 0.5R) · 8h time stop |

Plus the **ICT Sniper** (1h sweep → displacement → FVG inside killzones — Silver Bullet windows,
6h time stop, no overnight holds).

## Backtested performance

Binance 1m klines · 0.10%/side fees · 0.02%/fill slippage · $1,000 per trade · portfolio cap 3 slots.

- **Frozen 50-day window** (2026-08-14 → 2026-10-03, BTC +33.6%): 176 trades, **44.9% win rate,
  PF 1.55, net +$853** — both desks profitable in both halves.
- **120-day window** (2026-06-05 → 2026-10-03, BTC +34.9%): 358 trades, **38.8% win rate,
  PF 1.20, net +$576** — first half was a hostile regime for every finalist variant; the desks
  remain the top-net choices of the whole battery.

Full tables, methodology and caveats: [backtest-reports/SUCCESS-RATE-REPORT.md](backtest-reports/SUCCESS-RATE-REPORT.md).

**Live ↔ research parity:** a port-fidelity verifier replays every research signal through the
live module — 3,727/3,727 fires reproduced, 0 misses, 0 extras, 0 geometry mismatches
(`backtest-reports/verify-daydesk-2026-10-03-04-19-06.json`).

## Commands

```bash
npm run dev        # dashboard (Vite)
npm run build      # production bundle

# research lab — freeze the clock at the last cached minute, portfolio replay, dump signals
node --max-old-space-size=6144 scripts/research-day.mjs --days 50 --only S7R6,S1R7 \
  --end 1790999100000 --portfolio 3 --dump-signals backtest-reports/day-signals.json

# port-fidelity check: every research fire must reproduce in src/lib/daydesk.js
node --max-old-space-size=6144 scripts/verify-daydesk.mjs --dump backtest-reports/day-signals.json
```

## Environment

Optional keys — the desks trade on keyless Binance data with or without them.
Vite inlines every `VITE_*` value into the client bundle, so treat keys as
deployment identifiers: rotate anything that leaks, avoid long-lived secrets.

| Variable | Unlocks | Notes |
|---|---|---|
| `VITE_GROQ_API_KEY` | Vio8 advisor + chat narration | Groq console key · `.env.local` (dev) + Vercel project env (deploy) |
| `VITE_CC_API_KEY` | CryptoCompare last-resort candle backup | Keyless tier now 401s |

## Layout

- `src/lib/daydesk.js` — the two frozen day desks (pure JSON out, Node-importable)
- `src/lib/ict.js` — the precision desk (1h sweep → displacement → FVG, killzone-gated)
- `src/lib/feeds.js` — candle/ticker transport: Binance primary + CORS-open mirror edges,
  CryptoCompare backup, shared source-health cooldowns (Node-importable for smoke tests)
- `src/hooks/useMarketFeed.js` — feed scheduler: 1m books, 15m day compression, 1000-bar
  1h day plane, BTC daily regime, price layers
- `src/hooks/useVio8Advisor.js` — the advisory layer / autopilot
- `scripts/research-day.mjs`, `scripts/verify-daydesk.mjs` — lab + verifier
- `backtest-reports/` — run artifacts and the success-rate report
