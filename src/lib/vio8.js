/**
 * vio8.js — accountability layer for the Vio8 advisor.
 *
 * Context: three harness rounds (~30k replayed trades) measured the
 * deterministic entry/exit skeleton as edge-less — every geometry and
 * entry-timing variant lost money after fees. Vio8 (the LLM layer) is the
 * remaining selectivity lever, so it gets:
 *   (a) a verdict ledger — every verdict + full market context + outcome,
 *   (b) a risk officer — rejects the signal shapes that bled in replay,
 *   (c) a rolling scorecard — injected back into its own prompt.
 */

export const VIO8_LEDGER_KEY = 'vortex_vio8_ledger';
const LEDGER_CAP = 1000;

/**
 * Risk-officer thresholds, grounded in the replay evidence:
 * - Round-trip fees are 0.2% of notional; targets under ~0.5% were pure noise.
 * - Stops tighter than 0.15% get noise-stopped; wider than 2% risks too much
 *   per unit (mirrors engine.planTrade's maxStopPct).
 * - Reward:risk floor of 1.5 keeps the payoff geometry honest.
 */
export const GATE = {
  minTargetPct: 0.005,
  minStopPct: 0.0015,
  maxStopPct: 0.02,
  minRr: 1.5,
};

/**
 * Day-desk policy: the NR7/RSI2 desks were validated WITHOUT geometry filters
 * (their own signal conditions are the filter), so this gate is deliberately
 * loose — it only catches degenerate math, it must never second-guess the
 * frozen research winners. 15m ATR stops land at ~0.4–4% and the 4R/8R targets
 * at 1.6–14% across the majors–alts spread, hence the wide windows.
 */
export const DAY_GATE = {
  minTargetPct: 0.004,
  minStopPct: 0.0012,
  maxStopPct: 0.12,
  minRr: 2.0,
};

/**
 * Exposure discipline: a scalper's edge dies under stacked correlated risk.
 * The balance gate alone would allow up to 10 concurrent $1k positions;
 * the strategy caps the book at 3 (30% of the account).
 */
export const MAX_CONCURRENT_POSITIONS = 3;

const num = (v) => {
  // Number-first: exponential-notation strings ("9e-7" for sub-1e-6 prices)
  // are mangled by the character filter below ("9-7" -> 9). Only strip
  // currency/formatting noise when the value is not already numeric.
  const direct = typeof v === 'number' ? v : Number(String(v).trim());
  if (Number.isFinite(direct)) return direct;
  const cleaned = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(cleaned) ? cleaned : NaN;
};

export const loadLedger = () => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VIO8_LEDGER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writeStore = (entries) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VIO8_LEDGER_KEY, JSON.stringify(entries.slice(0, LEDGER_CAP)));
  } catch {
    /* quota or private mode — ledger is best-effort, never break trading */
  }
};

/**
 * Risk officer. Pure — returns { ok, reasons } for an EXECUTE signal.
 * Reasons are stable tags so rejections can be aggregated in the scorecard.
 */
export const validateVio8Signal = (advice, context = {}) => {
  if (!advice || advice.verdict !== 'EXECUTE LONG') {
    return { ok: false, reasons: ['NOT_EXECUTE'] };
  }

  const entry = num(advice.entry);
  const stop = num(advice.stopLoss);
  const target = num(advice.target);
  if (![entry, stop, target].every((n) => n > 0)) {
    return { ok: false, reasons: ['NON_NUMERIC'] };
  }

  const reasons = [];
  if (stop >= entry) reasons.push('STOP_NOT_BELOW_ENTRY');
  if (target <= entry) reasons.push('TARGET_NOT_ABOVE_ENTRY');
  if (reasons.length) return { ok: false, reasons };

  const stopPct = (entry - stop) / entry;
  const targetPct = (target - entry) / entry;
  const rr = targetPct / stopPct;

  // Strategy-aware windows: the precision desk and the day desks ride
  // different geometry bands (see DAY_GATE above).
  const gate = context.strategy === 'DAY_BREAKOUT' || context.strategy === 'DAY_CAPITULATION' ? DAY_GATE
    : GATE;
  // Boundary tolerance: both engines construct targets EXACTLY at the floor
  // (MIN_RR × risk) and round every level via toPrecision(8); the recomputed
  // ratio then lands a few ULPs under the floor (e.g. 2.9999995 < 3.0) and
  // was rejected as below-floor. A 1e-4 relative slack absorbs that float
  // noise at any legal stop width — a genuine violation is orders of
  // magnitude larger (a 2.5R bracket is 16% off, 1600× the tolerance).
  const EPS = 1e-4;
  if (targetPct < gate.minTargetPct * (1 - EPS)) reasons.push('TARGET_UNDER_FEE_FLOOR');
  if (stopPct < gate.minStopPct * (1 - EPS)) reasons.push('STOP_TOO_TIGHT');
  if (stopPct > gate.maxStopPct * (1 + EPS)) reasons.push('STOP_TOO_WIDE');
  if (rr < gate.minRr * (1 - EPS)) reasons.push('RR_BELOW_FLOOR');
  // The 1H regime check is a lagging filter — it stands down when a deterministic
  // engine has already confirmed a structure-backed execute ([EXECUTING] for the
  // ICT machine, [DAY_EXECUTING] for the day desks). Structure leads; the regime
  // filter only guards entries that lack structural confirmation.
  const structureConfirmed = context.ict === 'EXECUTING' || context.ict === 'DAY_EXECUTING';
  if (context.direction === 'BEARISH' && !structureConfirmed) reasons.push('BEARISH_REGIME');
  if (context.kingdomThreat === 'WAR' || context.kingdomThreat === 'CATASTROPHE') {
    reasons.push('THREAT_LOCKDOWN');
  }

  return { ok: reasons.length === 0, reasons };
};

/**
 * Record one verdict (any type) with its context and risk-officer ruling.
 * Returns the ledger id so the resulting trade can be linked back.
 */
export const appendVerdict = ({ symbol, price, advice, context, gate }) => {
  const entry = {
    id: `v8_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    t: Date.now(),
    symbol,
    price: num(price),
    verdict: advice?.verdict || 'UNKNOWN',
    risk: advice?.risk || null,
    entry: num(advice?.entry),
    stopLoss: num(advice?.stopLoss),
    target: num(advice?.target),
    rationale: advice?.rationale || null,
    context: context || null,
    gate: gate || null,
    outcome: null,
  };

  const ledger = loadLedger();
  ledger.unshift(entry);
  writeStore(ledger);
  return entry.id;
};

/**
 * Write trade results back onto their ledger entries.
 * outcomes: [{ id, outcome: { status, usdPnl?, exitPrice?, closedAt } }]
 */
export const applyOutcomes = (outcomes) => {
  if (!outcomes || outcomes.length === 0) return;
  const ledger = loadLedger();
  let touched = false;
  for (const { id, outcome } of outcomes) {
    const e = ledger.find((x) => x.id === id);
    if (e) {
      e.outcome = outcome;
      touched = true;
    }
  }
  if (touched) writeStore(ledger);
};

/**
 * Rolling track record derived from closed ledger entries.
 * Includes per-symbol records, calibration by Vio8's own risk rating,
 * and the three most recent closes with hold time — the raw material
 * for its self-review loop.
 */
export const buildScorecard = (entries = loadLedger()) => {
  const sc = {
    total: entries.length,
    executes: 0,
    gatedRejections: 0,
    rejectionReasons: {},
    closed: 0,
    wins: 0,
    losses: 0,
    abandoned: 0,
    expired: 0,
    netUsd: 0,
    avgWin: 0,
    avgLoss: 0,
    last5: [],
    byRisk: {},       // LOW / MEDIUM / HIGH / UNRATED -> { w, l, net }
    bySymbol: {},     // symbol -> { w, l, a, e, net }
    recentClosed: [], // newest first: { symbol, status, usdPnl, holdMin, t }
  };

  let winSum = 0;
  let lossSum = 0;
  const closedChron = [];

  for (const e of entries) {
    if (e.verdict === 'EXECUTE LONG') sc.executes++;
    if (e.gate && !e.gate.ok) {
      sc.gatedRejections++;
      for (const r of e.gate.reasons) {
        sc.rejectionReasons[r] = (sc.rejectionReasons[r] || 0) + 1;
      }
    }
    const o = e.outcome;
    if (!o) continue;

    const pnl = parseFloat(o.usdPnl) || 0;
    closedChron.push({ t: o.closedAt || e.t, status: o.status, symbol: e.symbol, usdPnl: pnl, holdMin: o.holdMin ?? null });

    const sym = (sc.bySymbol[e.symbol] = sc.bySymbol[e.symbol] || { w: 0, l: 0, a: 0, e: 0, net: 0 });
    sym.net += pnl;

    if (o.status === 'WIN') { sc.wins++; winSum += pnl; sym.w++; }
    else if (o.status === 'LOSS') { sc.losses++; lossSum += pnl; sym.l++; }
    else if (o.status === 'ABANDONED') { sc.abandoned++; sym.a++; }
    else if (o.status === 'EXPIRED') { sc.expired++; sym.e++; }

    if (o.status === 'WIN' || o.status === 'LOSS') {
      const key = e.risk || 'UNRATED';
      const r = (sc.byRisk[key] = sc.byRisk[key] || { w: 0, l: 0, net: 0 });
      r.net += pnl;
      if (o.status === 'WIN') r.w++; else r.l++;
    }

    sc.netUsd += pnl;
  }

  sc.closed = sc.wins + sc.losses + sc.abandoned;
  sc.avgWin = sc.wins ? winSum / sc.wins : 0;
  sc.avgLoss = sc.losses ? lossSum / sc.losses : 0;

  const sorted = closedChron.sort((a, b) => b.t - a.t);
  sc.last5 = sorted.slice(0, 5).map((c) => (c.status || '?')[0]);
  sc.recentClosed = sorted.slice(0, 3);

  return sc;
};

const fmtHold = (min) => {
  if (!Number.isFinite(min)) return '';
  const m = Math.round(min);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

/**
 * Human-readable scorecard block for the Vio8 prompt.
 * Pass the trading symbol to add its personal record line.
 */
export const scorecardForPrompt = (sc, symbol = null) => {
  if (!sc || sc.total === 0) {
    return '- No recorded history yet — this is your first era. Only execute A+ setups; every verdict is logged and scored.';
  }
  const lines = [
    `- Verdicts logged: ${sc.total} (EXECUTE: ${sc.executes}, risk-officer rejections: ${sc.gatedRejections})`,
    `- Closed trades: ${sc.closed} | W ${sc.wins} / L ${sc.losses} / abandoned ${sc.abandoned} / never-filled ${sc.expired}`,
    `- Net P&L: $${sc.netUsd.toFixed(2)} | avg win $${sc.avgWin.toFixed(2)} | avg loss $${sc.avgLoss.toFixed(2)} | last 5: ${sc.last5.join(' ') || '—'}`,
  ];

  const sym = symbol && sc.bySymbol ? sc.bySymbol[symbol] : null;
  if (sym && (sym.w + sym.l + sym.a) > 0) {
    lines.push(`- Your record on ${symbol}: W ${sym.w} / L ${sym.l} / abandoned ${sym.a} | net $${sym.net.toFixed(2)}`);
  }

  if (sc.recentClosed?.length) {
    const detail = sc.recentClosed
      .map((c) => {
        const tag = c.status === 'WIN' ? 'target' : c.status === 'LOSS' ? 'stop' : c.status === 'ABANDONED' ? 'timeout' : 'never filled';
        const hold = fmtHold(c.holdMin);
        return `${(c.symbol || '?').split('-')[0]} ${(c.status || '?')[0]} $${c.usdPnl.toFixed(2)} (${tag}${hold ? `, ${hold}` : ''})`;
      })
      .join('; ');
    lines.push(`- Recent closes: ${detail}`);
  }

  const riskKeys = Object.keys(sc.byRisk || {});
  if (riskKeys.length) {
    const parts = riskKeys.map((k) => {
      const r = sc.byRisk[k];
      const wr = r.w + r.l > 0 ? Math.round((r.w / (r.w + r.l)) * 100) : 0;
      return `${k} ${r.w}W/${r.l}L (${wr}%, net $${r.net.toFixed(2)})`;
    });
    lines.push(`- Calibration by your own risk rating: ${parts.join(' | ')}`);
  }

  const top = Object.entries(sc.rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => `${r} x${n}`)
    .join(', ');
  if (top) lines.push(`- Rejections by risk officer: ${top}`);

  return lines.join('\n');
};
