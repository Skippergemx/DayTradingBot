// ── DAILY-LOSS CIRCUIT BREAKER ────────────────────────────────────────────────
// The week-1 capital guard: when a UTC day's realized, fee-included P&L reaches
// −3% of the day's STARTING equity, every new arm is blocked until the UTC day
// rolls over. Open positions are not touched — they keep being managed to their
// stop/target/time exits; only NEW risk is refused. The anchor (which day, the
// equity it started at) persists in localStorage so a page reload cannot reset
// the count. No manual override — the point is exactly that there isn't one.

export const BREAKER = {
  DAILY_LOSS_PCT: 0.03,  // −3% of the day's starting equity trips the breaker
  KEY: 'vortex_breaker_v1',
};

/** UTC day key — the breaker's calendar is UTC, matching the research desks. */
export const utcDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Persisted day anchor { dayUtc, startEquity }. Written on first evaluation and
 * again at every UTC rollover (the new day anchors to the CURRENT equity, so a
 * bleeding day can't poison the next one's limit).
 */
export function ensureDayAnchor(now, currentEquity) {
  const dayUtc = utcDayKey(now);
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(BREAKER.KEY) || 'null'); } catch { /* corrupt storage — keep null */ }
  if (!raw || raw.dayUtc !== dayUtc || !(Number(raw.startEquity) > 0)) {
    const equity = Number(currentEquity);
    raw = { dayUtc, startEquity: Number.isFinite(equity) && equity > 0 ? equity : 0 };
    try { localStorage.setItem(BREAKER.KEY, JSON.stringify(raw)); } catch { /* storage unavailable */ }
  }
  return raw;
}

/** Realized (fee-included) net of every final trade closed inside the UTC day. */
export function realizedNetOn(trades, dayUtc) {
  let net = 0;
  for (const t of trades || []) {
    if (!t.closedAt || t.usdPnl == null) continue;
    if (utcDayKey(t.closedAt) !== dayUtc) continue;
    const v = parseFloat(t.usdPnl);
    if (Number.isFinite(v)) net += v;
  }
  return net;
}

/**
 * Breaker verdict for the current paper book.
 * { tripped, dayUtc, startEquity, realizedNet, limitUsd, lossPct }
 * lossPct shows the day's realized move as a % of the day's starting equity.
 */
export function breakerVerdict(trades, currentEquity, now = Date.now()) {
  const anchor = ensureDayAnchor(now, currentEquity);
  const realizedNet = realizedNetOn(trades, anchor.dayUtc);
  const limitUsd = anchor.startEquity * BREAKER.DAILY_LOSS_PCT;
  const tripped = limitUsd > 0 && realizedNet <= -limitUsd;
  return {
    tripped, dayUtc: anchor.dayUtc, startEquity: anchor.startEquity,
    realizedNet, limitUsd,
    lossPct: anchor.startEquity > 0 ? (realizedNet / anchor.startEquity) * 100 : 0,
  };
}
