// ── RISK LAYER — portfolio construction controls ──────────────────────────────
// Sits between the desk engines and execution: the engine proposes, the officer
// vets geometry, and this layer keeps the BOOK honest — one risk unit per
// correlated cluster, and no re-entering a symbol that just proved the level
// wrong. Measured origin (60d replay, Sep damage): the FET/AGIX/OCEAN
// clone cluster produced three identical insta-stops from a single event, and
// NEAR re-entered 3 days after its first stop-out — and stopped again.
// Portfolio-book semantics; the probe book stays raw signal by design.

export const RISK = {
  COOLDOWN_MS: 3 * 24 * 60 * 60 * 1000, // post-stop no-trade window per symbol
  CORR_WINDOW: 120,       // 1H bars of log-returns for the cluster check (~5d)
  CORR_MIN_BARS: 60,      // minimum overlap before a pair verdict is issued
  CORR_MAX: 0.85,         // rho >= this => candidate is the same bet as a held one
};

/** Simple log-returns of a close series (oldest -> newest). */
export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    out.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  return out;
}

/** Pearson correlation of two series; null when degenerate. */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/**
 * Correlation cap — is the candidate statistically the same bet as any open
 * position? Takes the raw 1H close series (oldest -> newest) of the candidate
 * and [symbol, closes] pairs for the held book. Returns { symbol, rho } of the
 * first offending holding, or null when the candidate stands alone.
 */
export function correlatedWith(candidateCloses, heldPairs, opts = {}) {
  const win = opts.window ?? RISK.CORR_WINDOW;
  const minBars = opts.minBars ?? RISK.CORR_MIN_BARS;
  const max = opts.max ?? RISK.CORR_MAX;
  const cand = logReturns(candidateCloses.slice(-(win + 1)));
  for (const [sym, closes] of heldPairs) {
    const held = logReturns(closes.slice(-(win + 1)));
    const n = Math.min(cand.length, held.length);
    if (n < minBars) continue;
    const rho = pearson(cand.slice(-n), held.slice(-n));
    if (rho != null && rho >= max) return { symbol: sym, rho: +rho.toFixed(3) };
  }
  return null;
}

/** Stop-out cooldown — is the symbol still cooling after a losing settle? */
export function cooldownBlocked(cooldowns, symbol, now) {
  const until = cooldowns.get(symbol);
  return until != null && now < until;
}

/**
 * Live cooldown derivation — the most recent losing settle time for a symbol
 * from the paper book (usePaperTracker rows carry closedAt + fee-included
 * usdPnl; unfilled EXPIRED orders have no P&L and never start a cooldown).
 * Mirrors the harness trigger: net < 0 at settle → symbol on cooldown.
 */
export function lastLosingSettle(trades, symbol) {
  let last = null;
  for (const t of trades || []) {
    if (t.symbol !== symbol || !t.closedAt) continue;
    if (parseFloat(t.usdPnl) < 0) last = last == null ? t.closedAt : Math.max(last, t.closedAt);
  }
  return last;
}
