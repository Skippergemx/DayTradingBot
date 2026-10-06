// ── POSITION SIZING & PROFIT MATH (pure) ──────────────────────────────────────
// Extracted from the paper tracker so the money math stays testable in Node
// (the hook itself is React). One idea lives here:
//
//   RISK-PARITY SIZING — every trade risks roughly the same ~$30 to its
//   stop. Wide stops shrink the notional; tight stops stay capped at the
//   desk-standard $1,000 so three concurrent slots still fit the 30%-of-
//   account plan. Before this, a flat $1,000 bet risked anywhere from $2
//   (0.15% precision stop) to $120 (12% wide stop) — same "conviction",
//   wildly different stakes.
//
// Dependency-free on purpose — importable from both the browser bundle and the
// Node verification harnesses.

export const SIZING = {
  RISK_BUDGET_USD: 30,   // dollars risked to the stop at 1.0× (~0.3% of the 10k book)
  MAX_NOTIONAL: 1000,    // desk standard — keeps the 3-slot 30%-of-account plan
  MIN_NOTIONAL: 200,     // floor so a trade can't shrink into fee-noise dust
  FEE_RATE: 0.001,       // per side — mirrors the paper tracker
  STOP_GAP_MULT: 1.5,    // a stop may fill this many × the origin risk through the
                         // stop before the fill is floored (see boundedStopFill)
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Risk-parity position size.
 *   size = clamp(RISK_BUDGET / stopPct, MIN_NOTIONAL, MAX_NOTIONAL)
 * The floor only binds beyond ~15% stops, which the officer gates never emit.
 * Returns { size, risk, stopPct, parity } or null when the geometry is unusable.
 */
export const computePositionSize = ({
  entry, stop,
  riskBudget = SIZING.RISK_BUDGET_USD,
  maxNotional = SIZING.MAX_NOTIONAL,
  minNotional = SIZING.MIN_NOTIONAL,
}) => {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  if (!(entry > 0) || !(stop > 0) || stop >= entry) return null;
  const stopPct = (entry - stop) / entry;
  const parity = riskBudget / stopPct;
  const size = Math.max(minNotional, Math.min(maxNotional, parity));
  return {
    size: round2(size),
    risk: round2(size * stopPct),
    stopPct: round2(stopPct * 100),   // percent, display-friendly
    parity: round2(parity),           // uncapped parity notional (diagnostics)
  };
};

/** Committed notional still on an open trade (the full risk-parity size). */
export const remainingNotional = (trade) => trade.size ?? SIZING.MAX_NOTIONAL;

/**
 * Settlement — one formula for WIN/LOSS/ABANDONED closes. The entry fee is
 * deducted once here; the exit fee accrues on the notional at close, so total
 * costs = 2× size × feeRate. `pnlPct` is the numeric percent move, not the
 * formatted string.
 */
export const closeLegNet = ({ remaining, pnlPct, entryFee, feeRate = SIZING.FEE_RATE }) => (
  remaining * (pnlPct / 100) - entryFee - remaining * feeRate
);

/**
 * Bounded stop fill — a stop is a market exit, so it fills at the stop level,
 * but a genuine discontinuous flush can print worse. Honor at most `gapMult ×`
 * the origin risk as the fill, i.e. floor the print at `stopLoss −
 * (gapMult − 1) × risk0`. Without the floor a thin-print wick or a bad tick
 * settles near 0 and books the whole notional (size × ≈ −100%). Returns the
 * fill price; a non-finite print falls back to the floored stop.
 */
export const boundedStopFill = ({
  stopLoss, price, risk0,
  gapMult = SIZING.STOP_GAP_MULT,
}) => {
  const floor = (gapMult > 1 && risk0 > 0) ? stopLoss - (gapMult - 1) * risk0 : stopLoss;
  const p = Number(price);
  return Math.max(Number.isFinite(p) ? p : floor, floor);
};
