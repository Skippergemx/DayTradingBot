// ── TRAILING-7-DAY SCOREBOARD ─────────────────────────────────────────────────
// "Profitable within a week" has to be a measurement, not a feeling. This module
// scores the paper book over a rolling 7-day window — net, trades, win rate,
// profit factor and max drawdown, overall and per desk — against a BTC
// buy-and-hold of the same starting equity. The window anchor (tracking start,
// equity, BTC reference) persists in localStorage so a reload cannot
// cherry-pick a flattering window.

export const SCOREBOARD = {
  WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  KEY: 'vortex_scoreboard_v1',
};

const FINAL = new Set(['WIN', 'LOSS', 'ABANDONED', 'EXPIRED']);

// Desk identity per trade.strategy — mirrors usePaperTracker's CURRENT_DESKS.
export const DESK_TAGS = {
  ICT_PRECISION: { tag: 'ICT', label: 'ICT Sniper' },
  DAY_BREAKOUT: { tag: 'DAY-NR7', label: 'Day Breakout' },
  DAY_CAPITULATION: { tag: 'DAY-RSI2', label: 'Day Cap' },
  DAY_VWAP_FADE: { tag: 'DAY-VWAP', label: 'Day VWAP' },
  LEGACY: { tag: 'LEGACY', label: 'Legacy' },
};

const tagOf = (strategy) => (DESK_TAGS[strategy] ? DESK_TAGS[strategy].tag : 'LEGACY');
const TAG_ORDER = ['ICT', 'DAY-NR7', 'DAY-RSI2', 'DAY-VWAP', 'LEGACY'];

/**
 * Persisted window anchor { windowStart, startEquity, btcStartPrice }. Created
 * once both the equity and a live BTC mark exist, then left alone — the
 * scoreboard's rolling edge is always max(last-7d, windowStart).
 */
export function ensureWindow(now, currentEquity, btcPriceNow) {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SCOREBOARD.KEY) || 'null'); } catch { /* corrupt storage — keep null */ }
  const anchorOk = raw
    && Number.isFinite(Number(raw.windowStart))
    && Number(raw.startEquity) > 0
    && Number(raw.btcStartPrice) > 0;
  if (anchorOk) return raw;
  const equity = Number(currentEquity);
  const btc = Number(btcPriceNow);
  // A window needs a live BTC mark to benchmark against — retry until it lands.
  if (!(Number.isFinite(equity) && equity > 0) || !(Number.isFinite(btc) && btc > 0)) return null;
  const fresh = { windowStart: now, startEquity: equity, btcStartPrice: btc };
  try { localStorage.setItem(SCOREBOARD.KEY, JSON.stringify(fresh)); } catch { /* storage unavailable */ }
  return fresh;
}

/** BTC mark nearest at-or-before a target time from the daily plane. */
function btcCloseNear(bars, targetMs) {
  if (!Array.isArray(bars) || !bars.length) return null;
  let best = null;
  for (const b of bars) {
    if (b.time <= targetMs) best = b; else break;
  }
  const raw = best ? best.close : bars[0].close;
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Net / WR / PF / max-DD of one bucket of settled rows (realized curve order). */
function deskStats(rows) {
  const settled = rows.filter(t => FINAL.has(t.status) && t.closedAt);
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const net = settled.reduce((acc, t) => acc + (parseFloat(t.usdPnl) || 0), 0);
  const grossWin = wins.reduce((acc, t) => acc + Math.max(0, parseFloat(t.usdPnl) || 0), 0);
  const grossLoss = losses.reduce((acc, t) => acc + Math.max(0, -(parseFloat(t.usdPnl) || 0)), 0);
  const decisive = wins.length + losses.length;
  let peak = 0, dd = 0, run = 0;
  for (const t of [...settled].sort((a, b) => a.closedAt - b.closedAt)) {
    run += parseFloat(t.usdPnl) || 0;
    if (run > peak) peak = run;
    if (peak - run > dd) dd = peak - run;
  }
  return {
    n: settled.length, wins: wins.length, losses: losses.length,
    wrPct: decisive ? Math.round((wins.length / decisive) * 100) : null,
    net, pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    maxDD: dd,
  };
}

/**
 * The trailing-7-day scoreboard. `anchor` comes from ensureWindow(); when it is
 * still null (no BTC mark yet) the scoreboard renders as "syncing".
 * BTC benchmark: the daily plane's close at the window start; fallback to the
 * anchor's first-load mark when the plane does not reach back far enough.
 */
export function computeScoreboard({ trades, balance, btcDaily, btcPriceNow, anchor, now }) {
  const rollingStart = now - SCOREBOARD.WINDOW_MS;
  const windowStart = anchor ? Math.max(rollingStart, anchor.windowStart) : rollingStart;
  const inWindow = (trades || []).filter(t => FINAL.has(t.status) && t.closedAt && t.closedAt >= windowStart);

  const overall = deskStats(inWindow);
  const desks = TAG_ORDER
    .map(tag => ({ tag, ...deskStats(inWindow.filter(t => tagOf(t.strategy) === tag)) }))
    .filter(d => d.n > 0);

  const btcRef = btcCloseNear(btcDaily, windowStart) || (anchor ? Number(anchor.btcStartPrice) : null);
  const btc = Number(btcPriceNow);
  const ready = Number.isFinite(btc) && btc > 0 && Number.isFinite(btcRef) && btcRef > 0;

  const startEquity = balance - overall.net; // realized equity at the window's start
  const btcDeltaPct = ready ? (btc / btcRef - 1) * 100 : null;
  const btcPnlUsd = ready ? (startEquity * btcDeltaPct) / 100 : null;

  return {
    ready,
    windowStart,
    windowDays: (now - windowStart) / 86400e3,
    sinceTrackingDays: anchor ? (now - anchor.windowStart) / 86400e3 : null,
    startEquity,
    ...overall,
    desks,
    btcDeltaPct,
    btcPnlUsd,
    vsBtcUsd: ready ? overall.net - btcPnlUsd : null,
  };
}
