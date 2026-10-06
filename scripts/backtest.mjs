#!/usr/bin/env node
// ── VORTEX BACKTEST HARNESS ───────────────────────────────────────────────────
// Replays the live signal skeleton over historical Binance 1m candles.
//
// WHAT IS REPLAYED (via the exact shared code in src/lib/engine.js):
//   - Wilder RSI(14), EMA(20), volume / Buying-Pressure normalization
//   - scalpScore ranking, 1H trend + swing S/R (rebuilt from 1m buckets)
//   - Vio8 hard gates: Buying Pressure > 60%, WAR / CATASTROPHE threat block
//   - Trade geometry via the shared planTrade():
//       'swing' (legacy): stop = 20h swing low (fallback -1%), target =
//                          20h swing high (fallback +2%)
//       'atr'   (planned): risk = atrStopMult x ATR(bars), floored at
//                          minStopPct and capped at maxStopPct of price;
//                          target = rrMin x risk; skipped when the 20h swing
//                          high blocks the full target ("room to run" filter)
//   - Tracker rules: one trade per symbol, fixed $ size, fee per side,
//     trail to BE at +1% / BE+1% at +2%, abandon after 6h, wick-based fills
//     (if a candle touches both stop and target, the stop wins - pessimistic)
//   - Decision cadence: signals evaluated at 1m bar close; hourly trend is
//     refreshed every 15 minutes, like the live timer
//
// HOW THE SWEEP WORKS:
//   The shared engine is replayed ONCE per symbol-minute into typed arrays
//   (precomputeEvals), then every config in SWEEP_GRID re-runs the portfolio
//   simulation cheaply on top of those arrays. All configs therefore see
//   identical inputs, and the SWING row must reproduce the recorded baseline
//   exactly (BASELINE_REF) - that is the fidelity check for the refactor.
//   Trend-sensitive state (20h swing high/low) is stored as fresh per-minute
//   snapshots and consumed through a decision-time refresh timer (no refresh
//   within trendRefreshMin minutes), mirroring the live hourly-trend timer.
//
// WHAT IS NOT REPLAYED:
//   - The gpt-oss-20b LLM layer (not deterministic). This measures the
//     deterministic floor beneath the LLM, not its discretion.
//   - The live tracker's balance double-credit bug is NOT replicated here;
//     the harness uses correct realized-P&L accounting.
//
// Usage:
//   node scripts/backtest.mjs [--days 30] [--symbols ALL|BTC-USDT,ETH-USDT]
//     [--mode both|portfolio|per-symbol] [--balance 10000] [--size 1000]
//     [--fee 0.001] [--cache .backtest-cache] [--out backtest-reports]
//     [--warmup-days 2] [--concurrency 2] [--end <epoch-ms>]
//   Geometry:
//     [--strategy swing|atr] [--rr 1.5] [--atr-stop 1.0] [--atr-bars 1m|15m]
//     [--min-stop-pct 0.0] [--max-stop-pct 0.02]
//   Entry gates:
//     [--gate-pressure 60] [--below-ema] [--dip-depth 0.005] [--regime up|down]
//   Sweep:
//     [--sweep]   run the built-in config grid in portfolio mode and print a
//                 comparison table (1 engine pass + N cheap simulation passes)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMBOLS, BINANCE_MAP, BINANCE_SKIP } from '../src/lib/universe.js';
import {
  calculateRSI, calculateEMA, analyzeVolume, computeScalpScore,
  computeHourlyTrend, computeKingdomThreat, calculateATR, planTrade,
} from '../src/lib/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CFG = {
  days: 30,
  warmupDays: 2,
  symbols: null,          // null = all
  mode: 'both',
  balance: 10000,
  size: 1000,
  fee: 0.001,
  cacheDir: path.join(ROOT, '.backtest-cache'),
  outDir: path.join(ROOT, 'backtest-reports'),
  concurrency: 2,
  gatePressure: 60,       // Vio8 rule 1
  blockThreats: ['WAR', 'CATASTROPHE'],
  maxHoldMin: 360,        // tracker: abandon after 6h
  trendRefreshMin: 15,    // live hourly-trend timer
  // entry gates (sweep knobs — one variable per row)
  belowEma: false,        // require 1m price below the hourly EMA20
  dipDepth: 0,            // extra dip depth below EMA20 (fraction of EMA)
  regime: null,           // hourly EMA20 slope filter: 'up' | 'down' | null
  // geometry
  strategy: 'swing',      // 'swing' (legacy template) | 'atr' (planned risk)
  rrMin: 1.5,             // atr: target = rrMin x risk
  atrStopMult: 1.0,       // atr: risk = atrStopMult x ATR
  atrBars: '1m',          // atr: volatility yardstick timeframe ('1m' | '15m')
  minStopPct: 0,          // atr: stop floor as fraction of price (fee-noise guard)
  maxStopPct: 0.02,       // atr: stop cap as fraction of price
  endMs: null,            // freeze the window end (epoch ms) for reproducible runs
  sweep: false,           // run the built-in config grid
};

const args = process.argv.slice(2);
for (let a = 0; a < args.length; a++) {
  const key = args[a]?.replace(/^--/, '');
  if (key === 'sweep') { CFG.sweep = true; continue; }
  const val = args[++a];
  if (key == null || val == null) { console.warn(`Missing value for --${key}`); break; }
  switch (key) {
    case 'days': CFG.days = Number(val); break;
    case 'warmup-days': CFG.warmupDays = Number(val); break;
    case 'symbols': CFG.symbols = val.toUpperCase() === 'ALL' ? null : val.split(',').map(s => s.trim()); break;
    case 'mode': CFG.mode = val; break;
    case 'balance': CFG.balance = Number(val); break;
    case 'size': CFG.size = Number(val); break;
    case 'fee': CFG.fee = Number(val); break;
    case 'cache': CFG.cacheDir = path.resolve(ROOT, val); break;
    case 'out': CFG.outDir = path.resolve(ROOT, val); break;
    case 'concurrency': CFG.concurrency = Math.max(1, Math.min(4, Number(val))); break;
    case 'strategy': CFG.strategy = val; break;
    case 'rr': CFG.rrMin = Number(val); break;
    case 'atr-stop': CFG.atrStopMult = Number(val); break;
    case 'atr-bars': CFG.atrBars = val === '15m' ? '15m' : '1m'; break;
    case 'min-stop-pct': CFG.minStopPct = Number(val); break;
    case 'max-stop-pct': CFG.maxStopPct = Number(val); break;
    case 'gate-pressure': CFG.gatePressure = Number(val); break;
    case 'below-ema': CFG.belowEma = val !== 'false' && val !== '0'; break;
    case 'dip-depth': CFG.dipDepth = Number(val); break;
    case 'regime': CFG.regime = val === 'up' || val === 'down' ? val : null; break;
    case 'end': CFG.endMs = Number(val); break;
    default: console.warn(`Unknown flag: --${key}`);
  }
}
if (!['swing', 'atr'].includes(CFG.strategy)) { console.error(`Invalid --strategy ${CFG.strategy}`); process.exit(1); }

const NOW = Number.isFinite(CFG.endMs) ? CFG.endMs : Date.now();
const WINDOW_MS = CFG.days * 86400e3;
const WINDOW_START = NOW - WINDOW_MS;
const FETCH_START = NOW - (CFG.days + CFG.warmupDays) * 86400e3;

// Config grid for --sweep (portfolio mode). Row 1 is the fidelity control and
// must reproduce the fixed-replay reference (see BASELINE_REF note).
// INVERT-ENTRY ROUND: the momentum gate buys strength at the 20h high, where
// the swing target sits right above price (tiny reward, wide stop). These rows
// test the opposite timing — buy dips below the hourly EMA20 — holding exits
// and fees constant, one gate variable per row:
//  - p>60/50/0 : BuyingPressure thresholds on dip entries
//  - depth     : dip must extend >=0.5% below EMA20
//  - regime    : hourly EMA20 slope (dip in an uptrend vs catching a fall?)
//  - ATR rows  : dip timing with risk-sized targets instead of swing brackets.
const SWEEP_GRID = [
  { label: 'SWING control (ref)', strategy: 'swing' },
  { label: 'SWING dip<EMA20 p>60', strategy: 'swing', belowEma: true },
  { label: 'SWING dip<EMA20 p>50', strategy: 'swing', belowEma: true, gatePressure: 50 },
  { label: 'SWING dip<EMA20 any-p', strategy: 'swing', belowEma: true, gatePressure: 0 },
  { label: 'SWING dip50bp<EMA20 p>50', strategy: 'swing', belowEma: true, gatePressure: 50, dipDepth: 0.005 },
  { label: 'SWING dip<EMA20 p>50 uptrend', strategy: 'swing', belowEma: true, gatePressure: 50, regime: 'up' },
  { label: 'SWING dip<EMA20 p>50 downtrend', strategy: 'swing', belowEma: true, gatePressure: 50, regime: 'down' },
  { label: 'ATR-15m x1.5 rr2.0 dip p>50', strategy: 'atr', atrBars: '15m', atrStopMult: 1.5, rrMin: 2.0, belowEma: true, gatePressure: 50 },
  { label: 'ATR-15m x1.5 rr2.0 dip uptrend', strategy: 'atr', atrBars: '15m', atrStopMult: 1.5, rrMin: 2.0, belowEma: true, gatePressure: 50, regime: 'up' },
  { label: 'ATR-15m x1.5 rr2.5 dip p>50', strategy: 'atr', atrBars: '15m', atrStopMult: 1.5, rrMin: 2.5, belowEma: true, gatePressure: 50 },
];

// FIDELITY NOTE (2026-09-16): the original recorded baseline
// (backtest-reports/backtest-2026-09-16-14-36-07.json: -$1147.09, 1033 trades,
// 588/353/92) was produced by the pre-refactor harness whose hourly-trend
// snapshot degraded into multi-hour staleness and then froze per symbol mid-run
// (verified: ETH swing values freeze for 10h+ spans, entries stop entirely
// after 2026-08-19 while prices keep moving; its 0.74% accept rate is
// impossible under any lagged-snapshot model - a truly fresh predicate accepts
// 99.9% of signal minutes). The baseline is an artifact of the stale snapshot,
// not live-app behavior, so it is retired as a fidelity target. The refactored
// engine was validated independently: early trades match the old run exactly
// (ETH 14:31 / 15:50 / 16:19 identical entries, exits and holds), swing values
// match a raw-cache replica (1913.53 @ 08-17 15:48), and hourly buckets match
// cache aggregates. The SWING row must now reproduce THIS reference (fixed
// harness, same frozen window end):
//   portfolio: 2246 closed (906/880/460), net -$3502.02
//   per-symbol: 12057 closed (5466/4612/1979), net -$22358.64
const BASELINE_REF = { net: -3502.02, trades: 2246, wins: 906, losses: 880, abandoned: 460 };

// ── SMALL UTILS ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt$ = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const fmtPct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const banner = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

// ── KLINE FETCHING (Binance 1m, with disk cache) ──────────────────────────────
async function fetchJson(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if ((res.status === 429 || res.status === 418) && attempt <= 3) {
        console.warn(`  rate-limited (${res.status}) - backing off ${attempt * 5}s`);
        await sleep(attempt * 5000);
        return fetchJson(url, attempt + 1);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (attempt <= 3) {
      await sleep(1500 * attempt);
      return fetchJson(url, attempt + 1);
    }
    throw err;
  }
}

const klinesUrl = (pair, startMs, endMs) =>
  `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;

async function fetchRange(pair, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  let reqs = 0;
  while (cursor < endMs) {
    const batch = await fetchJson(klinesUrl(pair, cursor, endMs));
    reqs++;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const k of batch) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const lastOpen = batch[batch.length - 1][0];
    if (batch.length < 1000) break;
    cursor = lastOpen + 60000;
    await sleep(90);
  }
  return { rows: out, reqs };
}

async function loadCandles(symbol) {
  const base = symbol.split('-')[0];
  const pair = (BINANCE_MAP[base] || base) + 'USDT';
  const cacheFile = path.join(CFG.cacheDir, `1m_${pair}.json`);

  let cached = [];
  if (fs.existsSync(cacheFile)) {
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cached = []; }
  }

  let reqs = 0;
  const endMs = NOW;
  if (cached.length === 0) {
    const { rows, reqs: r } = await fetchRange(pair, FETCH_START, endMs);
    reqs += r;
    cached = rows;
  } else {
    const first = cached[0][0];
    const last = cached[cached.length - 1][0];
    if (first > FETCH_START + 60000) {
      const { rows, reqs: r } = await fetchRange(pair, FETCH_START, first - 1);
      reqs += r;
      cached = rows.concat(cached);
    }
    if (last < endMs - 5 * 60000) {
      const { rows, reqs: r } = await fetchRange(pair, last + 60000, endMs);
      reqs += r;
      if (rows.length) cached = cached.concat(rows);
    }
  }

  // dedupe + sort + drop any still-forming candle vs the (possibly frozen) NOW
  const seen = new Map();
  for (const row of cached) if (!seen.has(row[0]) || seen.get(row[0])[1] === 0) seen.set(row[0], row);
  let rows = [...seen.values()].sort((a, b) => a[0] - b[0]);
  while (rows.length && rows[rows.length - 1][0] + 60000 > NOW) rows = rows.slice(0, -1);

  fs.mkdirSync(CFG.cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(rows));
  return { pair, rows, reqs };
}

// ── PREPROCESSING ─────────────────────────────────────────────────────────────
function prepare(symbol, rows) {
  // Candle objects use the engine's canonical field names (the same shape the
  // live fetch produces), so every calculation runs the identical code path.
  const candles = rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
  const idxByT = new Map();
  candles.forEach((c, i) => idxByT.set(c.time, i));
  let evalStart = candles.findIndex(c => c.time >= WINDOW_START);
  if (evalStart < 0) evalStart = candles.length;
  return { symbol, candles, idxByT, evalStart };
}

// Sequential minute evaluator: keeps 1m rolling window, hourly buckets and
// 15m buckets in sync, and recomputes the 1H trend on the live timer cadence.
function makeEvaluator(p, btc, eth) {
  let i = 0;               // next candle index to ingest
  let completedBuckets = [];
  let curBucket = null;
  let completed15 = [];
  let cur15 = null;
  let emaSlopePct = 0;     // hourly EMA20 slope (rising = uptrend regime)

  // Recomputed whenever an hourly bucket completes (hourly cadence, not
  // per-minute): EMA20 through the latest completed buckets vs through the
  // previous set — the classic rising/falling regime signal, independent of
  // where price sits relative to the EMA.
  function recomputeSlope() {
    const cl = completedBuckets.slice(-50);
    if (cl.length < 23) { emaSlopePct = 0; return; }
    const a = calculateEMA(cl, 20);
    const b = calculateEMA(cl.slice(0, -1), 20);
    emaSlopePct = (a && b) ? (a / b - 1) * 100 : 0;
  }

  function advanceTo(idx) {
    for (; i <= idx; i++) {   // i already points at the next unprocessed candle
      const c = p.candles[i];
      const hs = Math.floor(c.time / 3600e3) * 3600e3;
      if (!curBucket || curBucket.time !== hs) {
        if (curBucket) { completedBuckets.push(curBucket); recomputeSlope(); }
        curBucket = { time: hs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      } else {
        if (c.high > curBucket.high) curBucket.high = c.high;
        if (c.low < curBucket.low) curBucket.low = c.low;
        curBucket.close = c.close;
        curBucket.volume += c.volume;
      }
      const qs = Math.floor(c.time / 900e3) * 900e3;
      if (!cur15 || cur15.time !== qs) {
        if (cur15) completed15.push(cur15);
        cur15 = { time: qs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      } else {
        if (c.high > cur15.high) cur15.high = c.high;
        if (c.low < cur15.low) cur15.low = c.low;
        cur15.close = c.close;
        cur15.volume += c.volume;
      }
    }
  }

  const change24h = (src, t) => {
    const j = src.idxByT.get(t);
    if (j == null || j < 1440) return NaN;
    const then = src.candles[j - 1440].close;
    return then > 0 ? (src.candles[j].close / then - 1) * 100 : NaN;
  };

  return function evaluate(idx) {
    advanceTo(idx);
    const c = p.candles[idx];
    const window = p.candles.slice(Math.max(0, idx - 199), idx + 1);

    const price = c.close;
    const rsi = calculateRSI(window);
    const ema = calculateEMA(window, 20);
    const dist = price ? ((ema - price) / ema) * 100 : 0;
    const vol = analyzeVolume(window, 20, c.time + 60000 - 1);
    const score = computeScalpScore(rsi, dist);

    // Fresh trend snapshot for this minute; the simulations layer their own
    // refresh policy on top (live = hourly trend re-fetched every 15 minutes).
    const trend = computeHourlyTrend([...completedBuckets.slice(-49), curBucket]);

    // Volatility yardsticks for risk sizing (see planTrade):
    //  - atr1m : ATR(14) over the rolling 200x1m window (fine, fee-relevant)
    //  - atr15m: ATR(14) over resampled 15m buckets (holding-timeframe scale)
    const atr1m = calculateATR(window, 14);
    const w15 = cur15 ? [...completed15.slice(-29), cur15] : [];
    const atr15m = w15.length >= 15 ? calculateATR(w15, 14) : 0;

    const threat = computeKingdomThreat(change24h(btc, c.time), change24h(eth, c.time));
    const signal = !!trend && vol.pressure > CFG.gatePressure && !CFG.blockThreats.includes(threat);

    return { t: c.time, price, rsi, dist, score, pressure: vol.pressure, trend, threat, signal, atr1m, atr15m, emaSlope: emaSlopePct };
  };
}

// ── EVALUATION PRECOMPUTE ─────────────────────────────────────────────────────
// Runs the shared engine once per symbol-minute and stores the results in typed
// arrays, so a sweep of N configs costs N cheap simulation passes instead of N
// full engine replays. Float64 where exactness matters (prices, brackets),
// int16 for the already-integer engine outputs, uint8 for the gate flag.
function precomputeEvals(prepared) {
  let total = 0;
  for (const p of prepared) {
    if (p.evalStart >= p.candles.length - 10) { p.evals = null; continue; }
    const evaluate = makeEvaluator(p, p.btc, p.eth);
    const n = p.candles.length - p.evalStart;
    const f = {
      n,
      price: new Float64Array(n),
      atr1m: new Float64Array(n),
      atr15m: new Float64Array(n),
      swingHigh: new Float64Array(n),
      swingLow: new Float64Array(n),
      ema20: new Float64Array(n),
      rsi: new Float64Array(n),
      pressure: new Int16Array(n),
      score: new Int16Array(n),
      dir: new Int8Array(n),
      slope: new Float64Array(n),
      blocked: new Uint8Array(n),
    };
    for (let idx = p.evalStart, k = 0; idx < p.candles.length; idx++, k++) {
      const ev = evaluate(idx);
      f.price[k] = ev.price;
      f.atr1m[k] = ev.atr1m;
      f.atr15m[k] = ev.atr15m;
      f.swingHigh[k] = ev.trend ? ev.trend.swingHigh : 0;
      f.swingLow[k] = ev.trend ? ev.trend.swingLow : 0;
      f.ema20[k] = ev.trend ? ev.trend.ema20 : 0;
      f.rsi[k] = ev.rsi;
      f.pressure[k] = ev.pressure;
      f.score[k] = ev.score;
      f.dir[k] = ev.trend ? (ev.trend.direction === 'BULLISH' ? 1 : ev.trend.direction === 'BEARISH' ? -1 : 0) : 0;
      f.slope[k] = ev.emaSlope;
      // Precomputed block = trend unavailable or threat blocked; the per-row
      // pressure / dip / direction gates are applied by the simulators.
      f.blocked[k] = (ev.trend && !CFG.blockThreats.includes(ev.threat)) ? 0 : 1;
    }
    p.evals = f;
    total += n;
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return total;
}

// ── GEOMETRY ─────────────────────────────────────────────────────────────────
// Single code path through the shared engine planner. The 'swing' strategy is
// the legacy template (stop = 20h swing low, target = 20h swing high) and must
// behave identically to the pre-refactor inline geometry.
// `snap` is the decision-time trend snapshot: exactly what the scanner would
// have known at this minute, given the live 15-minute trend refresh timer.
function geometryFrom(f, k, snap, cfg) {
  return planTrade({
    price: f.price[k],
    atr: cfg.atrBars === '15m' ? f.atr15m[k] : f.atr1m[k],
    swingHigh: snap.swH,
    swingLow: snap.swL,
    strategy: cfg.strategy,
    rrMin: cfg.rrMin,
    atrStopMult: cfg.atrStopMult,
    minStopPct: cfg.minStopPct,
    maxStopPct: cfg.maxStopPct,
  });
}

// Per-row entry gates layered on top of the precomputed block flag (one
// variable per sweep row):
//  - gatePressure    : BuyingPressure must exceed it (Vio8 rule 1)
//  - belowEma/dipDepth: 1m price must sit below the hourly EMA20
//  - regime          : hourly EMA20 slope must be 'up' or 'down'
function entryAllowed(f, k, cfg) {
  if (f.blocked[k]) return false;
  if (f.pressure[k] <= cfg.gatePressure) return false;
  if (cfg.belowEma && !(f.ema20[k] > 0 && f.price[k] < f.ema20[k] * (1 - (cfg.dipDepth || 0)))) return false;
  if (cfg.regime === 'up' && !(f.slope[k] > 0)) return false;
  if (cfg.regime === 'down' && !(f.slope[k] < 0)) return false;
  return true;
}

// Wick-based walk-forward with stop-first pessimism + trailing stops is
// implemented inline in both simulators below (per-symbol and portfolio) so
// each can maintain its own open-trade state without extra bookkeeping.

// ── SIMULATIONS ───────────────────────────────────────────────────────────────
function runPerSymbol(prepared, cfg) {
  const trades = [];
  let signalsSeen = 0, geometryRejected = 0;

  for (const p of prepared) {
    const f = p.evals;
    if (!f) continue;
    let open = null;
    const snap = { idx: -1e9, swH: 0, swL: 0 };   // decision-time trend state

    for (let k = 0; k < f.n; k++) {
      const idx = p.evalStart + k;
      if (open) {
        const c = p.candles[idx];
        if (c.low <= open.stop) { record(open, 'LOSS', idx, open.stop); }
        else if (c.high >= open.target) { record(open, 'WIN', idx, open.target); }
        else {
          if (c.high >= open.entry * 1.01) open.stop = Math.max(open.stop, open.entry);
          if (c.high >= open.entry * 1.02) open.stop = Math.max(open.stop, open.entry * 1.01);
          if (idx - open.i >= cfg.maxHoldMin) record(open, 'ABANDONED', idx, c.close);
        }
        continue;
      }

      if (!snap.swH || idx - snap.idx >= cfg.trendRefreshMin) {
        snap.swH = f.swingHigh[k];
        snap.swL = f.swingLow[k];
        snap.idx = idx;
      }
      if (!entryAllowed(f, k, cfg)) continue;
      signalsSeen++;
      const geo = geometryFrom(f, k, snap, cfg);
      if (!geo) { geometryRejected++; continue; }
      open = {
        symbol: p.symbol, i: idx, t: p.candles[idx].time,
        entry: geo.entry, stop: geo.stop, target: geo.target,
        score: f.score[k], rsi: f.rsi[k], pressure: f.pressure[k],
      };
    }

    function record(ot, status, exitIdx, exit) {
      const totalFee = cfg.size * cfg.fee * 2;
      const net = cfg.size * (exit / ot.entry - 1) - totalFee;
      trades.push({ ...ot, status, exitT: p.candles[exitIdx].time, exit, holdMin: exitIdx - ot.i, net });
      open = null;
    }

    // data ended while a trade was still live — record it as open-at-end
    if (open) {
      const lastIdx = p.candles.length - 1;
      trades.push({ ...open, status: 'OPEN_AT_END', exitT: null, exit: null, holdMin: lastIdx - open.i, net: 0 });
      open = null;
    }
  }
  return { trades, signalsSeen, geometryRejected };
}

function runPortfolio(prepared, cfg) {
  const trades = [];
  let signalsSeen = 0, geometryRejected = 0, realized = 0;
  const openBySymbol = new Map();
  const trendState = new Map();   // symbol -> decision-time trend snapshot

  const btcP = prepared.find(p => p.symbol === 'BTC-USDT');
  const minuteList = btcP
    ? btcP.candles.map(c => c.time).filter(t => t >= WINDOW_START)
    : [];

  for (const t of minuteList) {
    // 1) manage open trades (catch up any skipped candles)
    for (const p of prepared) {
      const ot = openBySymbol.get(p.symbol);
      if (!ot) continue;
      const idx = p.idxByT.get(t);
      if (idx == null) continue;
      let closed = null;
      while (!closed && ot.j <= idx && ot.j < p.candles.length) {
        const c = p.candles[ot.j];
        if (c.low <= ot.stop) closed = { status: 'LOSS', exit: ot.stop };
        else if (c.high >= ot.target) closed = { status: 'WIN', exit: ot.target };
        else {
          if (c.high >= ot.entry * 1.01) ot.stop = Math.max(ot.stop, ot.entry);
          if (c.high >= ot.entry * 1.02) ot.stop = Math.max(ot.stop, ot.entry * 1.01);
          if (ot.j - ot.i >= cfg.maxHoldMin) closed = { status: 'ABANDONED', exit: c.close };
          ot.j++;
        }
      }
      if (closed) {
        const net = cfg.size * (closed.exit / ot.entry - 1) - cfg.size * cfg.fee * 2;
        realized += net;
        trades.push({ symbol: p.symbol, i: ot.i, t: ot.t, entry: ot.entry, score: ot.score, rsi: ot.rsi, pressure: ot.pressure, status: closed.status, exitT: p.candles[Math.min(ot.j, p.candles.length - 1)].time, exit: closed.exit, holdMin: ot.j - ot.i, net });
        openBySymbol.delete(p.symbol);
      }
    }

    // 2) one new entry per minute — best scalpScore among gate-passers
    if (openBySymbol.size * cfg.size + cfg.size <= cfg.balance + realized) {
      const candidates = [];
      for (const p of prepared) {
        if (openBySymbol.has(p.symbol) || !p.evals) continue;
        const idx = p.idxByT.get(t);
        if (idx == null || idx < p.evalStart) continue;
        const k = idx - p.evalStart;
        const f = p.evals;
        let snap = trendState.get(p.symbol);
        if (!snap) { snap = { idx: -1e9, swH: 0, swL: 0 }; trendState.set(p.symbol, snap); }
        if (!snap.swH || idx - snap.idx >= cfg.trendRefreshMin) {
          snap.swH = f.swingHigh[k];
          snap.swL = f.swingLow[k];
          snap.idx = idx;
        }
        if (!entryAllowed(f, k, cfg)) continue;
        signalsSeen++;
        const geo = geometryFrom(f, k, snap, cfg);
        if (!geo) { geometryRejected++; continue; }
        candidates.push({ p, idx, geo, score: f.score[k], rsi: f.rsi[k], pressure: f.pressure[k] });
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length) {
        const { p, idx, geo, score, rsi, pressure } = candidates[0];
        openBySymbol.set(p.symbol, { i: idx, j: idx + 1, t: p.candles[idx].time, entry: geo.entry, stop: geo.stop, target: geo.target, score, rsi, pressure });
      }
    }
  }

  // leave anything still open marked open-at-end
  for (const [sym, ot] of openBySymbol) {
    trades.push({ symbol: sym, i: ot.i, t: ot.t, entry: ot.entry, score: ot.score, rsi: ot.rsi, pressure: ot.pressure, status: 'OPEN_AT_END', exitT: null, exit: null, holdMin: 0, net: 0 });
  }

  return { trades, signalsSeen, geometryRejected, realized };
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function summarize(trades, label, cfg) {
  const closed = trades.filter(t => t.status !== 'OPEN_AT_END');
  const wins = closed.filter(t => t.status === 'WIN');
  const losses = closed.filter(t => t.status === 'LOSS');
  const abandoned = closed.filter(t => t.status === 'ABANDONED');
  const decided = wins.length + losses.length;

  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = losses.reduce((a, t) => a + Math.min(0, t.net), 0);
  const totalPnl = closed.reduce((a, t) => a + t.net, 0);

  // equity curve / max drawdown (ordered by exit time)
  const byExit = closed.slice().sort((a, b) => (a.exitT || 0) - (b.exitT || 0));
  let eq = cfg.balance, peak = eq, maxDD = 0;
  for (const t of byExit) { eq += t.net; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }

  const monthly = {};
  for (const t of byExit) {
    const key = new Date(t.exitT).toISOString().slice(0, 7);
    monthly[key] = monthly[key] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    monthly[key].trades++;
    if (t.status === 'WIN') monthly[key].wins++;
    if (t.status === 'LOSS') monthly[key].losses++;
    monthly[key].pnl += t.net;
  }

  const perSymbol = {};
  for (const t of closed) {
    const s = perSymbol[t.symbol] = perSymbol[t.symbol] || { trades: 0, wins: 0, losses: 0, abandoned: 0, pnl: 0 };
    s.trades++;
    s.pnl += t.net;
    if (t.status === 'WIN') s.wins++;
    if (t.status === 'LOSS') s.losses++;
    if (t.status === 'ABANDONED') s.abandoned++;
  }

  const holdAvg = closed.length ? closed.reduce((a, t) => a + t.holdMin, 0) / closed.length : 0;

  return {
    label,
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    abandoned: abandoned.length,
    openAtEnd: trades.length - closed.length,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    expectancy: closed.length ? totalPnl / closed.length : 0,
    profitFactor: grossLoss !== 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? Infinity : 0),
    totalPnl,
    finalBalance: cfg.balance + totalPnl,
    returnPct: (totalPnl / cfg.balance) * 100,
    maxDrawdown: maxDD,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    avgHoldMin: holdAvg,
    monthly, perSymbol, equityFinal: eq,
  };
}

// ── REPORTING ─────────────────────────────────────────────────────────────────
function printSummary(s, cfg) {
  banner(`== ${s.label.toUpperCase()} ==`);
  console.log(`  Closed trades: ${s.trades}  (W/L/A: ${s.wins}/${s.losses}/${s.abandoned})  Open at end: ${s.openAtEnd}`);
  console.log(`  Win rate (W/L): ${s.winRate.toFixed(1)}%   Expectancy: ${fmt$(s.expectancy)}/trade   Profit factor: ${s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2)}`);
  console.log(`  Total P&L: ${fmt$(s.totalPnl)}  (${fmtPct(s.returnPct)} on ${'$' + cfg.balance})   Max drawdown: $${Math.abs(s.maxDrawdown).toFixed(2)}`);
  console.log(`  Avg win: ${fmt$(s.avgWin)}   Avg loss: ${fmt$(s.avgLoss)}   Avg hold: ${s.avgHoldMin.toFixed(0)} min`);
  console.log('  Monthly:');
  for (const [k, m] of Object.entries(s.monthly).sort()) {
    const wr = m.wins + m.losses ? ((m.wins / (m.wins + m.losses)) * 100).toFixed(0) + '%' : '-';
    console.log(`    ${k}: ${padL(m.trades, 4)} trades  WR ${padL(wr, 4)}  P&L ${fmt$(m.pnl)}`);
  }
}

function printPerSymbol(s, topN = 6) {
  const rows = Object.entries(s.perSymbol)
    .map(([sym, v]) => ({ sym, ...v }))
    .sort((a, b) => b.pnl - a.pnl);
  banner(`== PER-SYMBOL (${s.label}) ==`);
  console.log(`  ${pad('SYMBOL', 12)}${padL('TRADES', 7)}${padL('W', 4)}${padL('L', 4)}${padL('WR', 5)}${padL('PNL', 11)}`);
  const line = (r) => {
    const wr = r.wins + r.losses ? ((r.wins / (r.wins + r.losses)) * 100).toFixed(0) + '%' : '-';
    console.log(`  ${pad(r.sym, 12)}${padL(r.trades, 7)}${padL(r.wins, 4)}${padL(r.losses, 4)}${padL(wr, 5)}${padL(fmt$(r.pnl), 11)}`);
  };
  if (rows.length <= topN * 2) {
    rows.forEach(line);
    return;
  }
  rows.slice(0, topN).forEach(line);
  console.log('  ...');
  rows.slice(-topN).reverse().forEach(line);
}

function printComparison(rows) {
  banner('== CONFIG COMPARISON (PORTFOLIO MODE, SORTED BY NET) ==');
  const sorted = rows.slice().sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  console.log(`  ${pad('CONFIG', 36)}${padL('SIGNALS', 9)}${padL('GEO-REJ', 8)}${padL('TRADES', 7)}${padL('WR%', 6)}${padL('NET', 10)}${padL('GROSS/TR', 9)}${padL('PF', 6)}${padL('EXP/TR', 8)}${padL('MAXDD', 8)}`);
  for (const r of sorted) {
    const s = r.stats;
    const rejPct = r.signalsSeen ? ((r.geometryRejected / r.signalsSeen) * 100).toFixed(1) + '%' : '-';
    const gross = (s.totalPnl + s.trades * CFG.size * CFG.fee * 2) / Math.max(1, s.trades);
    console.log(`  ${pad(r.label, 36)}${padL(r.signalsSeen, 9)}${padL(rejPct, 8)}${padL(s.trades, 7)}${padL(s.winRate.toFixed(1), 6)}${padL(fmt$(s.totalPnl), 10)}${padL(fmt$(gross), 9)}${padL(s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2), 6)}${padL(fmt$(s.expectancy), 8)}${padL('$' + Math.abs(s.maxDrawdown).toFixed(0), 8)}`);
  }
  console.log('  GROSS/TR = per-trade P&L with the $2 fee load added back (the fee-free edge).');
}

function printFidelity(row) {
  const s = row.stats;
  const dNet = s.totalPnl - BASELINE_REF.net;
  const ok = Math.abs(dNet) < 0.005 && s.trades === BASELINE_REF.trades
    && s.wins === BASELINE_REF.wins && s.losses === BASELINE_REF.losses && s.abandoned === BASELINE_REF.abandoned;
  banner('== FIDELITY CHECK (SWING vs FIXED-REPLAY REFERENCE) ==');
  console.log(`  net ${fmt$(s.totalPnl)} vs ${fmt$(BASELINE_REF.net)}  (delta ${fmt$(dNet)})`);
  console.log(`  trades ${s.trades}/${BASELINE_REF.trades} | W ${s.wins}/${BASELINE_REF.wins} | L ${s.losses}/${BASELINE_REF.losses} | A ${s.abandoned}/${BASELINE_REF.abandoned}`);
  console.log(`  -> ${ok ? 'EXACT MATCH - SWING reproduces the fixed-replay reference' : 'MISMATCH - sim changed, do not trust the sweep yet'}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const universe = (CFG.symbols || SYMBOLS).filter(s => {
    const base = s.split('-')[0];
    if (BINANCE_SKIP.includes(base)) { console.warn(`  skipping ${s} (no Binance pair)`); return false; }
    return true;
  });

  console.log('VORTEX BACKTEST HARNESS');
  console.log(`  Window: last ${CFG.days} days (warmup ${CFG.warmupDays}d) | ${universe.length} symbols${CFG.endMs ? ' | FROZEN end' : ''}`);
  console.log(`  ${iso(WINDOW_START)}  ->  ${iso(NOW)}  (end epoch ms: ${NOW})`);
  console.log(`  Gates: BuyingPressure > ${CFG.gatePressure} | block ${CFG.blockThreats.join('/')} | fee ${(CFG.fee * 100).toFixed(2)}% x2 | size $${CFG.size}`);
  const geoLabel = CFG.sweep
    ? `sweep grid (${SWEEP_GRID.length} configs, portfolio mode)`
    : CFG.strategy === 'swing'
      ? 'swing template (20h S/R brackets)'
      : `ATR-${CFG.atrBars} x${CFG.atrStopMult} rr${CFG.rrMin}${CFG.minStopPct ? ` floor ${(CFG.minStopPct * 100).toFixed(2)}%` : ''}`;
  console.log(`  Geometry: ${geoLabel}`);
  console.log('  NOTE: replays the deterministic skeleton only — the Vio8 LLM layer is not replayed.');

  banner('== FETCHING 1m KLINES ==');
  const preparedAll = [];
  let fetchTotal = 0;
  for (let w = 0; w < universe.length; w += CFG.concurrency) {
    const wave = universe.slice(w, w + CFG.concurrency);
    await Promise.all(wave.map(async (symbol) => {
      try {
        const { pair, rows, reqs } = await loadCandles(symbol);
        fetchTotal += reqs;
        const p = prepare(symbol, rows);
        preparedAll.push(p);
        process.stdout.write(`  [${String(w + wave.indexOf(symbol) + 1).padStart(3)}/${universe.length}] ${pad(pair, 10)} ${padL(rows.length, 6)} candles  (${reqs} requests)\n`);
      } catch (err) {
        console.warn(`  FAILED ${symbol}: ${err.message}`);
      }
    }));
  }

  const bySymbol = new Map(preparedAll.map(p => [p.symbol, p]));
  const prepared = preparedAll.filter(p => p.evalStart < p.candles.length - 10);
  const btc = bySymbol.get('BTC-USDT');
  const eth = bySymbol.get('ETH-USDT');
  if (btc) { btc.btc = btc; btc.eth = eth; }
  for (const p of prepared) { p.btc = btc; p.eth = eth; }

  console.log(`\n  ${prepared.length} symbols prepared (${fetchTotal} fetches this run)`);
  if (!btc) { console.error('BTC-USDT missing — cannot simulate. Aborting.'); process.exit(1); }

  banner('== PRECOMPUTING SIGNAL EVALUATIONS (shared engine, runs once) ==');
  const t0 = Date.now();
  const totalEvals = precomputeEvals(prepared);
  console.log(`  ${totalEvals.toLocaleString()} symbol-minutes evaluated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const results = {};
  if (CFG.sweep) {
    banner('== CONFIG SWEEP (PORTFOLIO MODE) ==');
    const rows = [];
    for (const g of SWEEP_GRID) {
      const cfg = { ...CFG, ...g };
      const t1 = Date.now();
      const r = runPortfolio(prepared, cfg);
      const stats = summarize(r.trades, g.label, cfg);
      rows.push({
        label: g.label,
        params: { strategy: g.strategy, atrBars: g.atrBars, atrStopMult: g.atrStopMult, rrMin: g.rrMin, minStopPct: g.minStopPct ?? 0 },
        stats,
        signalsSeen: r.signalsSeen,
        geometryRejected: r.geometryRejected,
      });
      console.log(`  ran ${pad(g.label, 38)} net ${padL(fmt$(stats.totalPnl), 10)}  ${padL(stats.trades, 5)} trades  WR ${stats.winRate.toFixed(1)}%  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    }
    printComparison(rows);
    const swingRow = rows.find(r => r.params.strategy === 'swing');
    if (swingRow) printFidelity(swingRow);

    const best = rows.filter(r => r.stats.trades > 0).sort((a, b) => b.stats.totalPnl - a.stats.totalPnl)[0];
    console.log(`\n  Best config: ${best.label}`);
    printSummary(best.stats, { ...CFG, ...best.params });
    printPerSymbol(best.stats);
    results.sweep = rows;
  } else {
    if (CFG.mode === 'both' || CFG.mode === 'per-symbol') {
      console.log('\nRunning per-symbol simulation (signal-quality probe, unlimited capital)...');
      const r = runPerSymbol(prepared, CFG);
      results.perSymbolMode = { stats: summarize(r.trades, 'PER-SYMBOL MODE', CFG), signalsSeen: r.signalsSeen, geometryRejected: r.geometryRejected, trades: r.trades };
    }
    if (CFG.mode === 'both' || CFG.mode === 'portfolio') {
      console.log('Running portfolio simulation (mirrors live capital rules)...');
      const r = runPortfolio(prepared, CFG);
      results.portfolioMode = { stats: summarize(r.trades, 'PORTFOLIO MODE', CFG), signalsSeen: r.signalsSeen, geometryRejected: r.geometryRejected, trades: r.trades };
    }

    if (results.perSymbolMode) {
      const m = results.perSymbolMode;
      banner('== SIMULATION FUNNEL (PER-SYMBOL) ==');
      console.log(`  Signals passing gates: ${m.signalsSeen}   Rejected geometry: ${m.geometryRejected}   Trades taken: ${m.stats.trades + m.stats.openAtEnd}`);
      printSummary(m.stats, CFG);
    }
    if (results.portfolioMode) {
      const m = results.portfolioMode;
      banner('== SIMULATION FUNNEL (PORTFOLIO) ==');
      console.log(`  Signals passing gates: ${m.signalsSeen}   Rejected geometry: ${m.geometryRejected}   Trades taken: ${m.stats.trades + m.stats.openAtEnd}`);
      printSummary(m.stats, CFG);
      printPerSymbol(m.stats);
    }
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outFile = path.join(CFG.outDir, `backtest-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    config: { ...CFG, symbols: universe },
    window: { start: WINDOW_START, end: NOW, days: CFG.days },
    baselineRef: BASELINE_REF,
    results,
  }, null, 2));
  console.log(`\nReport saved: ${outFile}`);
}

main().catch(err => { console.error('HARNESS CRASH:', err); process.exit(1); });
