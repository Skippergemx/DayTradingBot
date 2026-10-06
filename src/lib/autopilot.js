/**
 * autopilot.js — Vio8's desk-switching logic, rebuilt on the ICT framework.
 *
 * The scanner keeps all 42 symbols fresh in the background; this module turns
 * that firehose into a decision: which desk should Vio8 work from?
 *
 * STRUCTURE LEADS. The primary ranking input is the deterministic state machine
 * behind the active strategy: `lib/ict.js` for ICT_PRECISION (sweep →
 * displacement → FVG mitigation → execution) and `lib/daydesk.js` for the two
 * frozen intraday desks (15m NR7 breakout, 15m RSI(2) capitulation). Every
 * ladder always outranks a desk that is merely drifting.
 * Lagging context (pressure, RSI-derived scalp score, 24h drift, volume trend)
 * is DEMOTED to tiebreaker weight — it can nudge a ranking but can never veto a
 * structurally valid desk. That was the old paralysis: RSI windows and
 * EMA-distance gates freezing every candidate.
 *
 * Pure + deterministic: same board in, same pick out — her "why" is auditable.
 */

import { ICT } from './ict.js';

export const AUTOPILOT = {
  reviewMs: 60 * 1000,         // how often she re-ranks the board
  minGapMs: 3 * 60 * 1000,     // minimum time between two autonomous switches
  manualHoldMs: 5 * 60 * 1000, // a manual click freezes her hunting for this long
  switchMargin: 8,             // hysteresis: a challenger must beat the incumbent by this
  workableFloor: 35,           // below this, no desk is worth working — she stands down
};

const num = (v, fallback = NaN) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// Structural state → base rank. The ladder IS the score; everything else is a
// nudge. Keep in sync with ICT_STATES (lib/ict.js) and DAY_STATES (lib/daydesk.js).
const STATE_SCORE = {
  EXECUTING: 100,
  DAY_EXECUTING: 100,          // NR7 break / RSI2 flush — bracket armed
  FVG_MITIGATION: 80,
  DAY_COMPRESSION: 80,         // NR7 bucket live / flush printing — waiting on the tape
  DISPLACEMENT_DETECTED: 60,
  WAITING_FOR_KILLZONE: 45,
  SCANNING_SWEEP: 15,
  DAY_HUNTING: 15,             // hunting compression / a flush — same floor
  NO_DATA: 5,
};
const STATE_ORDER = { EXECUTING: 0, DAY_EXECUTING: 0, FVG_MITIGATION: 1, DAY_COMPRESSION: 1, DISPLACEMENT_DETECTED: 2, WAITING_FOR_KILLZONE: 3, SCANNING_SWEEP: 4, DAY_HUNTING: 4, NO_DATA: 5 };

/**
 * Rank the board for Vio8's next focus.
 * @param {Array} marketData  scanner rows (price, pressure, scalpScore, volumeTrend, change…)
 * @param {Object} opts
 * @param {Array}  opts.trades     open/pending trades (committed desks are skipped)
 * @param {Object} opts.structures map symbol → evaluateICT()/day-desk result
 *                                (whichever engine the active strategy feeds the desk)
 * Returns [{ symbol, score, state, bias, missing, reasons }] sorted best-first.
 */
export const scoreFocusCandidates = (marketData = [], { trades = [], structures = {} } = {}) => {
  const committed = new Set(
    trades
      .filter(t => t.status === 'OPEN' || t.status === 'PENDING')
      .map(t => t.symbol)
  );

  const rows = [];

  for (const m of marketData) {
    const price = num(m.price, 0);
    if (price <= 0) continue;
    if (committed.has(m.symbol)) continue; // position management, not a market gate

    const ict = structures[m.symbol] || null;
    const state = ict?.state && STATE_SCORE[ict.state] != null ? ict.state : 'NO_DATA';
    const desk = ict?.strategy === 'DAY_BREAKOUT' ? 'DAY-NR7'
      : ict?.strategy === 'DAY_CAPITULATION' ? 'DAY-RSI2'
      : 'ICT';

    let score = STATE_SCORE[state];
    const reasons = [];

    reasons.push(ict
      ? `${desk} ${state}${ict.bias && ict.bias !== 'NEUTRAL' ? ` (${ict.bias === 'BULLISH' ? 'bull' : 'bear'})` : ''}`
      : 'structure warming up');

    // ── Structural proximity: how close price is to the live entry level ──
    // ICT: the FVG consequent encroachment. DAY_COMPRESSION: the NR7 bucket
    // high the breakout must clear.
    const entryRef = ict?.fvg?.ce ?? ict?.zone?.entry ?? null;
    if (entryRef != null && (state === 'FVG_MITIGATION' || state === 'WAITING_FOR_KILLZONE' || state === 'DAY_COMPRESSION')) {
      const distPct = ((price - entryRef) / price) * 100;
      if (Number.isFinite(distPct)) {
        score += Math.max(0, 6 - Math.abs(distPct) * 4);
        if (Math.abs(distPct) < 1.5) reasons.push(`${Math.abs(distPct).toFixed(2)}% from ${ict?.fvg ? 'FVG CE' : 'zone entry'}`);
      }
    }

    // ── Context nudges (never vetoes) ──
    const pressure = num(m.volumePressure, 0);
    score += Math.min(10, Math.max(0, pressure * 0.1));
    if (pressure > 55) reasons.push(`pressure ${Math.round(pressure)}%`);

    const scalpScore = num(m.scalpScore, 10);
    score += Math.min(15, Math.max(0, scalpScore * 0.15));

    const change24 = num(m.change, 0);
    const wellbeing = Math.max(-10, Math.min(10, (change24 + 5) * 1.2));
    score += wellbeing;
    if (Math.abs(change24) >= 3) reasons.push(`${change24 > 0 ? '+' : ''}${change24.toFixed(1)}% 24h drift`);

    if (m.volumeTrend === 'ULTRA') { score += 5; reasons.push('ULTRA volume'); }
    else if (m.volumeTrend === 'HIGH') score += 3;
    else if (m.volumeTrend === 'LOW') score -= 3;

    rows.push({
      symbol: m.symbol,
      score: parseFloat(score.toFixed(1)),
      state,
      bias: ict?.bias || null,
      missing: ict?.missing || null,
      reasons,
    });
  }

  // Deterministic ordering: score desc, then ICT ladder, then symbol name.
  return rows.sort((a, b) =>
    b.score - a.score ||
    (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
    a.symbol.localeCompare(b.symbol)
  );
};

/** Convenience: does this ranked row actually clear the workable floor? */
export const isWorkable = (row) => !!row && row.score >= AUTOPILOT.workableFloor;

// Re-export for callers that want killzone awareness without a second import
export { ICT };
