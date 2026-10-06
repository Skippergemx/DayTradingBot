// ── LIVE LOOP — headless paper trader (24/7, no browser) ──────────────────────
// One TICK = fetch fresh Binance planes, manage open positions on new 1m bars,
// arm fresh desk signals, settle, persist state, print a summary.
//
// It reuses the SAME pure modules the app ships (feeds / daydesk / sizing), so
// the headless book mirrors the live desks — no rewrite, no drift. PAPER ONLY:
// no API keys, no orders, no exchange account.
//
// IDEMPOTENT BY CONSTRUCTION (safe under overlapping/duplicate/retried ticks):
//   · entries are deduped by the desk's stable structId (symbol:DESK:bucketTime)
//   · each open position advances its own `lastBarTs`, so a bar is managed once
//   · state is written back whole each tick — a re-run simply re-derives
//
// ENTRY/EXIT CONVENTIONS (deliberately conservative, documented so they can be
// audited against the app's usePaperTracker):
//   · entry fill  = the desk's own level (signal-bar close × 1.0002 slip)
//   · stop fill   = the stop level, or boundedStopFill(open) on a gap-through
//   · target fill = AT the target (a resting limit, as the app models it)
//   · time stop   = close of the bar that crosses the hold window
//   · intrabar     = when one 1m bar spans BOTH stop and target we assume the
//     STOP hit first (pessimistic; set CFG.pessimisticIntrabar=false to flip)
//
// USAGE
//   node scripts/live-loop.mjs                 # one tick   (GitHub Actions)
//   node scripts/live-loop.mjs --loop 300      # forever, every 300s (VM / PC)
//   node scripts/live-loop.mjs --state <path>  # custom state file
//   node scripts/live-loop.mjs --quiet         # suppress the stdout summary
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMBOLS } from '../src/lib/universe.js';
import { fetchDayCandles, fetchDay1h, fetchBtcDaily, fetchCandles } from '../src/lib/feeds.js';
import { evaluateDayBreakout, evaluateDayCapitulation, DAYDESK } from '../src/lib/daydesk.js';
import { SIZING, computePositionSize, closeLegNet, boundedStopFill } from '../src/lib/sizing.js';

const MIN = 60000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CFG = {
  statePath: path.join(ROOT, 'state', 'live-state.json'),
  balance0: 10000,            // starting paper equity (matches the app)
  maxSlots: 3,                // concurrent open positions (research cap 3)
  fetchConcurrency: 8,        // parallel symbol fetches
  closedKeep: 500,            // cap the persisted closed ledger
  seenKeep: 4000,             // cap the entry-dedupe set
  pessimisticIntrabar: true,  // stop-before-target when a bar spans both
};

// The two research-validated day desks. To also run the ICT precision desk,
// append { key:'ICT', eval:evaluateICT, maxHoldMs:6*3600000, cooldownMs:0 }
// (import evaluateICT from '../src/lib/ict.js') — it replays 1m slices and is
// heavier, so it is left out of the MVP loop on purpose.
const DESKS = [
  { key: 'DAY_BREAKOUT', eval: evaluateDayBreakout, maxHoldMs: DAYDESK.NR7.TIME_STOP_MIN * MIN, cooldownMs: 0 },
  { key: 'DAY_CAPITULATION', eval: evaluateDayCapitulation, maxHoldMs: DAYDESK.RSI2.TIME_STOP_MIN * MIN, cooldownMs: DAYDESK.RSI2.COOLDOWN_MIN * MIN },
];

// ── small utils ───────────────────────────────────────────────────────────────
const round2 = (n) => Math.round(n * 100) / 100;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function parseArgs(argv) {
  const a = { loop: 0, quiet: false, state: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--loop') a.loop = parseInt(argv[++i] || '300', 10) || 300;
    else if (v === '--state') a.state = argv[++i];
    else if (v === '--quiet') a.quiet = true;
  }
  if (a.state) CFG.statePath = path.resolve(a.state);
  return a;
}

const emptyState = () => ({
  version: 1,
  createdAt: Date.now(),
  updatedAt: null,
  balance: CFG.balance0,
  notional: SIZING.MAX_NOTIONAL,
  open: [],
  closed: [],
  seen: {},            // structId -> ts (entry dedupe)
  cooldowns: {},       // "SYM:DESK" -> untilTs (post-loss)
  scan: {},            // "SYM" -> newest completed 1m bar already scanned
  dayAnchor: null,     // { dayUtc, startEquity } for the −3% daily breaker
  lastBtc: null,
});

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.statePath, 'utf8'));
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(CFG.statePath), { recursive: true });
  state.updatedAt = Date.now();
  // keep the ledger bounded
  if (state.closed.length > CFG.closedKeep) state.closed = state.closed.slice(-CFG.closedKeep);
  const seenKeys = Object.keys(state.seen);
  if (seenKeys.length > CFG.seenKeep) {
    const keep = seenKeys.sort((a, b) => state.seen[b] - state.seen[a]).slice(0, CFG.seenKeep);
    const pruned = {};
    for (const k of keep) pruned[k] = state.seen[k];
    state.seen = pruned;
  }
  fs.writeFileSync(CFG.statePath, JSON.stringify(state, null, 2) + '\n');
}

// ── exits: manage one open position across the NEW 1m bars ────────────────────
function managePosition(pos, bars1m, now, log) {
  const since = pos.lastBarTs || pos.openedAt - MIN;
  const bars = (bars1m || []).filter((b) => b.time > since && b.time + MIN <= now).sort((a, b) => a.time - b.time);
  if (!bars.length) return null;

  let { stop, peak } = pos;
  const risk0 = pos.risk0;
  let armed = Boolean(pos.armed);
  const armAt = pos.entry + (pos.trail?.armR ?? 0.5) * risk0;

  for (const b of bars) {
    // ratchet the trailing stop off the bar's peak (RSI2 desk)
    if (pos.trail?.mode === 'RATCHET' && risk0 > 0) {
      peak = Math.max(peak, b.high);
      if (!armed && peak >= armAt) armed = true;
      if (armed) stop = Math.max(stop, peak - pos.trail.dist);
    }
    // 1) time stop — flat by the desk's hold window, at the bar close
    if (b.time + MIN - pos.openedAt >= pos.maxHoldMs) {
      return settle(pos, 'ABANDONED', b.close, b.time + MIN, { stop, peak, armed }, log);
    }
    // 2) stop (market) and 3) target (resting limit)
    const stopHit = b.low <= stop;
    const targetHit = b.high >= pos.target;
    if (stopHit && (!targetHit || CFG.pessimisticIntrabar)) {
      const fill = (b.open <= stop) ? boundedStopFill({ stopLoss: stop, price: b.open, risk0 }) : stop;
      return settle(pos, 'LOSS', fill, b.time + MIN, { stop, peak, armed }, log);
    }
    if (targetHit) {
      return settle(pos, 'WIN', pos.target, b.time + MIN, { stop, peak, armed }, log);
    }
    pos.lastBarTs = b.time;
    pos.stop = stop; pos.peak = peak; pos.armed = armed;
  }
  return null; // still open
}

function settle(pos, status, exitPrice, closedAt, live, log) {
  const size = pos.size;
  const pnlPct = ((exitPrice - pos.entry) / pos.entry) * 100;
  const net = closeLegNet({ remaining: size, pnlPct, entryFee: pos.entryFee ?? size * SIZING.FEE_RATE });
  const row = {
    id: pos.id, symbol: pos.symbol, strategy: pos.strategy, structId: pos.structId,
    entry: pos.entry, exitPrice: round2(exitPrice), stopLoss: pos.stopLoss, target: pos.target,
    status, size, usdPnl: round2(net), pnlPct: round2(pnlPct),
    openedAt: pos.openedAt, closedAt, holdMin: Math.round((closedAt - pos.openedAt) / MIN),
  };
  log.push(row);
  return row;
}

// ── one tick ──────────────────────────────────────────────────────────────────
async function tick(state, quiet) {
  const now = Date.now();
  const say = (...a) => { if (!quiet) console.log(...a); };

  say(`\n── tick ${iso(now)} ────────────────────────────────────────────`);

  // shared BTC context (one fetch each)
  const [btc1h, btcD] = await Promise.all([fetchDay1h('BTC-USDT'), fetchBtcDaily()]);
  const btcPx = Array.isArray(btc1h) && btc1h.length ? btc1h[btc1h.length - 1].close : null;

  // per-symbol planes (15m day book, 1h swing book, 1m tape) — one pass
  const planes = await mapLimit(SYMBOLS, CFG.fetchConcurrency, async (sym) => {
    const [k15, k1h, c1m] = await Promise.all([
      fetchDayCandles(sym), fetchDay1h(sym), fetchCandles(sym),
    ]);
    const k1m = (c1m && c1m.candles) || [];
    if (!k15.length || !k1h.length || !k1m.length) return null;
    return { sym, k15, k1h, k1m };
  });
  const bySym = new Map();
  for (const p of planes) if (p) bySym.set(p.sym, p);
  say(`  planes: ${bySym.size}/${SYMBOLS.length} symbols` + (btcPx ? ` · BTC ${round2(btcPx)}` : ''));

  // ── daily-loss breaker anchor (block NEW risk after −3% on the UTC day)
  if (!state.dayAnchor || state.dayAnchor.dayUtc !== utcDay(now)) {
    state.dayAnchor = { dayUtc: utcDay(now), startEquity: state.balance };
  }
  const realizedToday = state.closed
    .filter((t) => t.closedAt && utcDay(t.closedAt) === state.dayAnchor.dayUtc)
    .reduce((s, t) => s + (parseFloat(t.usdPnl) || 0), 0);
  const breakerTripped = state.dayAnchor.startEquity > 0
    && realizedToday <= -0.03 * state.dayAnchor.startEquity;

  // ── PHASE A: manage exits on open positions
  const settled = [];
  const stillOpen = [];
  for (const pos of state.open) {
    const p = bySym.get(pos.symbol);
    const row = p ? managePosition(pos, p.k1m, now, settled) : null;
    if (row) {
      state.balance = round2(state.balance + row.usdPnl);
      state.closed.push(row);
      if (row.status === 'LOSS') {
        const desk = DESKS.find((d) => d.key === row.strategy);
        if (desk && desk.cooldownMs > 0) state.cooldowns[`${row.symbol}:${row.strategy}`] = row.closedAt + desk.cooldownMs;
      }
    } else {
      stillOpen.push(pos);
    }
  }
  state.open = stillOpen;
  if (settled.length) say(`  settled: ${settled.map((r) => `${r.symbol.split('-')[0]} ${r.status} ${r.usdPnl >= 0 ? '+' : ''}$${r.usdPnl}`).join(', ')}`);

  // ── PHASE B: scan NEW completed 1m bars for fresh desk signals
  const openKeys = new Set(state.open.map((p) => `${p.symbol}:${p.strategy}`));
  const entries = [];
  if (!breakerTripped) {
    for (const p of bySym.values()) {
      const since = state.scan[p.sym] || 0;
      const bars = p.k1m.filter((b) => b.time > since && b.time + MIN <= now).sort((a, b) => a.time - b.time);
      if (!bars.length) continue;
      // Advance the per-symbol watermark ONLY over fully-scanned bars, so a
      // signal skipped because the book was full is re-seen once a slot frees.
      for (const bar of bars) {
        if (state.open.length + entries.length >= CFG.maxSlots) break;
        for (const desk of DESKS) {
          if (state.open.length + entries.length >= CFG.maxSlots) break;
          if (openKeys.has(`${p.sym}:${desk.key}`)) continue;
          const cd = state.cooldowns[`${p.sym}:${desk.key}`];
          if (cd && now < cd) continue;
          let out;
          try {
            out = desk.eval(p.k15, {
              symbol: p.sym, now: bar.time + MIN, price: bar.close,
              bars1h: p.k1h, btcBars1h: btc1h, btcDaily: btcD, bar1m: bar,
            });
          } catch { continue; }
          if (!out || !out.tradeable || !out.setup || !out.structId) continue;
          if (state.seen[out.structId]) continue;
          const s = out.setup;
          const plan = computePositionSize({ entry: s.entry, stop: s.stop });
          if (!plan) continue;
          if (state.balance - activeNotional(state, entries) < plan.size) continue; // free capital
          const pos = {
            id: `${desk.key}:${out.structId}:${bar.time}`,
            symbol: p.sym, strategy: desk.key, structId: out.structId,
            entry: s.entry, stopLoss: s.stop, target: s.target, stop: s.stop,
            risk0: s.entry - s.stop, peak: s.entry, armed: false,
            size: plan.size, entryFee: round2(plan.size * SIZING.FEE_RATE),
            trail: s.trail || { mode: 'NONE' }, targetSource: s.targetSource || null,
            openedAt: bar.time + MIN, lastBarTs: bar.time, maxHoldMs: desk.maxHoldMs,
          };
          state.seen[out.structId] = now;
          entries.push(pos);
          openKeys.add(`${p.sym}:${desk.key}`);
        }
        state.scan[p.sym] = bar.time;
      }
    }
  }
  if (entries.length) {
    for (const e of entries) {
      state.open.push(e);
      say(`  ARM  ${e.symbol.split('-')[0]} ${e.strategy} @ $${e.entry} · stop $${round2(e.stop)} · tgt $${e.target} · ${e.size}`);
    }
  }
  // ── summary
  const netAll = state.closed.reduce((s, t) => s + (parseFloat(t.usdPnl) || 0), 0);
  const wins = state.closed.filter((t) => t.status === 'WIN').length;
  const losses = state.closed.filter((t) => t.status === 'LOSS').length;
  state.lastBtc = btcPx;
  say(`  book:  eq $${state.balance} · net $${round2(netAll)} · closed ${state.closed.length} (${wins}W/${losses}L) · open ${state.open.length}/${CFG.maxSlots}` +
    (breakerTripped ? ' · BREAKER TRIPPED (no new risk)' : ''));
  return state;
}

const activeNotional = (state, extra = []) => {
  const sum = (list) => list.reduce((a, t) => a + (t.size ?? SIZING.MAX_NOTIONAL), 0);
  return sum(state.open) + sum(extra);
};

// ── main ──────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

async function runOnce() {
  const state = loadState();
  await tick(state, args.quiet);
  saveState(state);
}

if (args.loop > 0) {
  const intervalMs = args.loop * 1000;
  console.log(`live-loop: every ${args.loop}s · state ${CFG.statePath}`);
  // run immediately, then on a fixed cadence; never let one bad tick kill the loop
  const beat = async () => {
    try { const s = loadState(); await tick(s, args.quiet); saveState(s); }
    catch (e) { console.error(`tick error: ${e.message}`); }
    setTimeout(beat, intervalMs);
  };
  beat();
} else {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
