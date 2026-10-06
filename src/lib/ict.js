// ── ICT SILVER BULLET STATE MACHINE (pure, deterministic) ─────────────────────
// VIO8's decision core, rebuilt around price action instead of lagging
// indicators. The pipeline is a strict three-step hierarchy:
//
//   STEP A  LIQUIDITY SWEEP   — did price raid a recent swing high/low?
//   STEP B  DISPLACEMENT      — did a strong candle break market structure (MSS)?
//   STEP C  FAIR VALUE GAP    — is price returning to a clean, unmitigated FVG
//                               inside an ICT killzone window?
//
// Everything here is a pure function of (candles, now). No fetches, no React,
// no side effects — the UI telemetry ticker simply renders the returned JSON
// object and can never block or be blocked by the evaluation loop.
//
// Testable from Node (scripts) exactly as it runs in the browser.

import { calculateATR } from './engine.js';

// ── TUNING ────────────────────────────────────────────────────────────────────
export const ICT = {
  LOOKBACK: 150,               // bars of history the machine studies
  SWING_STRENGTH: 2,           // fractal pivot: 2 bars each side must respect it
  SWEEP_MAX_AGE: 45,           // a raid older than this is stale — re-hunt
  SWEEP_RECLAIM_BARS: 3,       // bars allowed to close back through the swept level
  SWEEP_MAX_OVERSHOOT_ATR: 1.0, // sweep bar close must stay within 1×ATR of the level,
                                // else it is a full breakdown, not a raid-and-reclaim
  DISPLACEMENT_ATR_MULT: 1.4,  // displacement candle body ≥ 1.4 × ATR(14)
  DISPLACEMENT_MAX_LAG: 12,    // MSS must follow the raid within 12 bars
  BODY_DOMINANCE: 0.55,        // body ≥ 55% of the candle's range (no wick games)
  FVG_MAX_LAG: 2,              // FVG must be imprinted at the displacement leg
  FVG_MIN_ATR: 0.12,           // ignore dust gaps (< 12% of ATR)
  ENTRY_MODE: 'CE',            // consequent encroachment (FVG midpoint) = entry
  STOP_BUFFER_ATR: 0.15,       // stop buffer beyond the FVG/sweep extreme
  MIN_RR: 1.5,                 // mirrors the risk officer's RR_BELOW_FLOOR
  TAP_FRESH_BARS: 10,          // CE tap still counts as live entry for ~10 bars
  TARGET_CLEARANCE: 0.998,     // park targets just inside opposing liquidity
};

// ── ICT KILLZONES (Silver Bullet windows, New York wall-clock time) ───────────
export const KILLZONES = [
  { id: 'LONDON_SB', label: 'London SB 03–04 ET', start: 3 * 60, end: 4 * 60 },
  { id: 'NY_AM_SB', label: 'NY AM SB 10–11 ET', start: 10 * 60, end: 11 * 60 },
  { id: 'NY_PM_SB', label: 'NY PM SB 14–15 ET', start: 14 * 60, end: 15 * 60 },
];

export const ICT_STATES = [
  'SCANNING_SWEEP',
  'DISPLACEMENT_DETECTED',
  'FVG_MITIGATION',
  'WAITING_FOR_KILLZONE',
  'EXECUTING',
];

// ── TIME / KILLZONE ───────────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});
/** Minutes since midnight in New York (DST-aware via the timezone database). */
const etMinutes = (now) => {
  const parts = ET_FMT.formatToParts(new Date(now));
  const h = +parts.find(p => p.type === 'hour').value % 24;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
};

/**
 * Which Silver Bullet window (if any) is open right now, and when the next
 * one opens. Pure function of `now` — the dashboard just renders it.
 */
export const killzoneState = (now = Date.now()) => {
  let mins;
  try { mins = etMinutes(now); } catch { return { active: false, id: null, label: 'KILLZONE —', minutesLeft: null, next: null }; }
  for (const kz of KILLZONES) {
    if (mins >= kz.start && mins < kz.end) {
      return { active: true, id: kz.id, label: kz.label, minutesLeft: kz.end - mins, next: null };
    }
  }
  let next = null;
  for (const kz of KILLZONES) {
    const startsInMin = (((kz.start - mins) % 1440) + 1440) % 1440 || 1440;
    if (!next || startsInMin < next.startsInMin) next = { id: kz.id, label: kz.label, startsInMin };
  }
  return { active: false, id: null, label: 'CLOSED', minutesLeft: null, next };
};

// ── FORMATTING (shared by feed, prompt, and telemetry) ────────────────────────
export const fmtPrice = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
};

// ── STEP 0: MARKET STRUCTURE PRIMITIVES ───────────────────────────────────────
/**
 * Fractal swing pivots — a bar whose high (or low) is the strict extreme for
 * `strength` bars on BOTH sides. These are the liquidity levels a raid targets.
 */
export const findSwings = (candles, from = 0, strength = ICT.SWING_STRENGTH) => {
  const highs = [];
  const lows = [];
  const last = candles.length - 1 - strength;
  for (let i = Math.max(strength, from); i <= last; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (candles[i].high <= candles[i - k].high || candles[i].high <= candles[i + k].high) isHigh = false;
      if (candles[i].low >= candles[i - k].low || candles[i].low >= candles[i + k].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
};

// ── STEP A: LIQUIDITY SWEEP ───────────────────────────────────────────────────
/**
 * The raid: price trades THROUGH a recent swing level and closes back through
 * it (same bar, or within `reclaimBars`). That is the engine that precedes a
 * Silver Bullet entry — not an RSI reading.
 * Returns the most recent raid: { dir, level, sweepIdx, extreme, reclaimIdx, ... }
 */
export const detectRaid = (candles, swings, atr = 0, maxAge = ICT.SWEEP_MAX_AGE, reclaimBars = ICT.SWEEP_RECLAIM_BARS) => {
  const len = candles.length;
  const windowStart = Math.max(0, len - maxAge);
  let best = null;

  const scout = (swingsList, dir) => {
    const isBull = dir === 'BULLISH'; // raiding a LOW → bullish reversal expectation
    for (const sw of swingsList) {
      if (sw.i + 1 >= len) continue;
      for (let i = Math.max(sw.i + 1, windowStart); i < len; i++) {
        const intruded = isBull ? candles[i].low < sw.price : candles[i].high > sw.price;
        if (!intruded) continue;
        // A raid must originate from the level's side: price approaching from the
        // wrong side (already trading beyond the level) is a breach, not a sweep.
        const origin = isBull ? candles[i].open > sw.price : candles[i].open < sw.price;
        if (!origin) continue;
        // Overshoot sanity: a sweep pokes the level and reclaims nearby. A bar
        // closing more than SWEEP_MAX_OVERSHOOT_ATR past the level is directional
        // continuation through the level — loading a raid onto it would misread
        // an established trend as a reversal setup.
        const overshoot = isBull ? candles[i].close - sw.price : sw.price - candles[i].close;
        if (atr > 0 && overshoot > ICT.SWEEP_MAX_OVERSHOOT_ATR * atr) continue;
        let reclaim = null;
        const closedBack = isBull ? candles[i].close > sw.price : candles[i].close < sw.price;
        if (closedBack) reclaim = i;
        else {
          for (let j = i + 1; j <= Math.min(i + reclaimBars, len - 1); j++) {
            const ok = isBull ? candles[j].close > sw.price : candles[j].close < sw.price;
            if (ok) { reclaim = j; break; }
          }
        }
        if (reclaim == null) continue;
        // Prefer the most recent raid bar; on the same bar, prefer the MOST RECENT
        // swing level raided (the liquidity closest to the present), not the first.
        if (!best || i > best.sweepIdx || (i === best.sweepIdx && sw.i > best.swingIdx)) {
          best = {
            dir,
            level: parseFloat(sw.price.toPrecision(8)),
            swingIdx: sw.i,
            extreme: isBull ? candles[i].low : candles[i].high,
            sweepIdx: i,
            reclaimIdx: reclaim,
            time: candles[i].time,
            ageBars: len - 1 - i,
          };
        }
        break; // first raid bar for this swing is its sweep event
      }
    }
  };

  scout(swings.lows, 'BULLISH');
  scout(swings.highs, 'BEARISH');
  return best;
};

// ── STEP B: DISPLACEMENT / MSS ────────────────────────────────────────────────
/**
 * After the raid, look for the displacement candle: a body ≥ 1.4 × ATR that
 * dominates its range and closes through the most recent opposing swing —
 * a Market Structure Shift. This is the proof of intent.
 */
export const detectDisplacement = (candles, atr, raid, swings) => {
  const len = candles.length;
  const isBull = raid.dir === 'BULLISH';
  const breaks = isBull ? swings.highs : swings.lows;
  const from = raid.sweepIdx + 1;
  const to = Math.min(len - 1, raid.sweepIdx + 1 + ICT.DISPLACEMENT_MAX_LAG);

  for (let j = from; j <= to; j++) {
    const c = candles[j];
    const body = isBull ? c.close - c.open : c.open - c.close;
    if (body <= 0) continue;
    const range = c.high - c.low;
    if (range <= 0) continue;
    if (body < ICT.DISPLACEMENT_ATR_MULT * atr) continue;
    if (body < ICT.BODY_DOMINANCE * range) continue;

    let mss = null; // most recent swing broken by the close (nearest in time)
    for (const sw of breaks) {
      if (sw.i >= j) continue;
      const broken = isBull ? c.close > sw.price : c.close < sw.price;
      if (broken && (!mss || sw.i > mss.i)) mss = sw;
    }
    if (!mss) continue;

    return {
      dir: raid.dir,
      idx: j,
      body: parseFloat(body.toPrecision(8)),
      bodyAtrMult: parseFloat((body / atr).toFixed(2)),
      rangePct: parseFloat(((range / c.close) * 100).toFixed(3)),
      mssLevel: parseFloat(mss.price.toPrecision(8)),
      mssIdx: mss.i,
      time: c.time,
      ageBars: len - 1 - j,
    };
  }
  return null;
};

// ── STEP C: FAIR VALUE GAP ────────────────────────────────────────────────────
/**
 * The imbalance the displacement leg imprinted: a 3-candle gap between
 * candle[k-1] and candle[k+1]. Only gaps born at the displacement leg qualify.
 */
export const detectFVG = (candles, disp, atr) => {
  const len = candles.length;
  const isBull = disp.dir === 'BULLISH';
  const from = Math.max(1, disp.idx - 1);
  const to = Math.min(len - 2, disp.idx + ICT.FVG_MAX_LAG);

  for (let k = from; k <= to; k++) {
    const a = candles[k - 1]; // older edge
    const c = candles[k + 1]; // newer edge (unfilled side)
    const gapSize = isBull ? c.low - a.high : a.low - c.high;
    if (gapSize <= 0) continue;
    if (gapSize < ICT.FVG_MIN_ATR * atr) continue;
    const bottom = parseFloat((isBull ? a.high : c.high).toPrecision(8));
    const top = parseFloat((isBull ? c.low : a.low).toPrecision(8));
    return {
      dir: disp.dir,
      bottom,
      top,
      ce: parseFloat(((bottom + top) / 2).toPrecision(8)),
      sizePct: parseFloat(((gapSize / c.close) * 100).toFixed(3)),
      createdIdx: k + 1,
      time: c.time,
    };
  }
  return null;
};

/** Track mitigation since creation: tap, CE tap, invalidation, current depth. */
export const trackFVG = (candles, fvg) => {
  const len = candles.length;
  const isBull = fvg.dir === 'BULLISH';
  let edgeTapped = false;
  let ceTapped = false;
  let tapIdx = null;
  let ceIdx = null;
  let invalidated = false;
  let deepest = isBull ? fvg.top : fvg.bottom;

  for (let i = fvg.createdIdx + 1; i < len; i++) {
    const c = candles[i];
    if (isBull) {
      if (c.close < fvg.bottom) { invalidated = true; break; }
      deepest = Math.min(deepest, c.low);
      if (!edgeTapped && c.low <= fvg.top) { edgeTapped = true; tapIdx = i; }
      if (!ceTapped && c.low <= fvg.ce) { ceTapped = true; ceIdx = i; }
    } else {
      if (c.close > fvg.top) { invalidated = true; break; }
      deepest = Math.max(deepest, c.high);
      if (!edgeTapped && c.high >= fvg.bottom) { edgeTapped = true; tapIdx = i; }
      if (!ceTapped && c.high >= fvg.ce) { ceTapped = true; ceIdx = i; }
    }
  }

  const last = candles[len - 1];
  const span = fvg.top - fvg.bottom || 1e-9;
  const mitigatedPct = isBull
    ? Math.min(1, Math.max(0, (fvg.top - deepest) / span))
    : Math.min(1, Math.max(0, (deepest - fvg.bottom) / span));
  // The creation bar IS an edge of the gap (its wick terminates at the top/bottom),
  // so "price in zone" can only be true for bars AFTER creation.
  const afterCreation = len - 1 > fvg.createdIdx;
  const inZone = afterCreation && (isBull
    ? last.low <= fvg.top && last.low >= fvg.bottom * 0.998
    : last.high >= fvg.bottom && last.high <= fvg.top * 1.002);

  return {
    edgeTapped, ceTapped, invalidated, tapIdx, ceIdx, inZone,
    mitigatedPct: parseFloat(mitigatedPct.toFixed(2)),
    ageBars: len - 1 - fvg.createdIdx,
  };
};

// ── BRACKET BUILDER ───────────────────────────────────────────────────────────
/**
 * Deterministic levels: entry at the FVG consequent encroachment (CE),
 * stop beyond the gap AND the raid extreme (liquidity was taken there),
 * target inside the nearest opposing liquidity pool — floored at MIN_RR.
 */
export const buildSetup = (atr, raid, fvg, swings) => {
  const isBull = fvg.dir === 'BULLISH';
  const entry = fvg.ce;
  const stop = isBull
    ? Math.min(fvg.bottom, raid.extreme) - ICT.STOP_BUFFER_ATR * atr
    : Math.max(fvg.top, raid.extreme) + ICT.STOP_BUFFER_ATR * atr;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  // Nearest opposing liquidity pool created before the FVG
  const pools = isBull ? swings.highs : swings.lows;
  let poolPrice = null;
  for (const sw of pools) {
    if (sw.i >= fvg.createdIdx) continue;
    const beyond = isBull ? sw.price > entry : sw.price < entry;
    if (!beyond) continue;
    if (poolPrice == null || (isBull ? sw.price < poolPrice : sw.price > poolPrice)) poolPrice = sw.price;
  }

  const minTarget = isBull ? entry + ICT.MIN_RR * risk : entry - ICT.MIN_RR * risk;
  const poolTarget = poolPrice != null ? poolPrice * (isBull ? ICT.TARGET_CLEARANCE : 2 - ICT.TARGET_CLEARANCE) : null;
  const usePool = poolTarget != null && (isBull ? poolTarget >= minTarget : poolTarget <= minTarget);
  const target = usePool ? poolTarget : minTarget;
  const rr = Math.abs(target - entry) / risk;

  return {
    direction: isBull ? 'LONG' : 'SHORT',
    entry: parseFloat(entry.toPrecision(8)),
    stop: parseFloat(stop.toPrecision(8)),
    target: parseFloat((usePool ? poolPrice * ICT.TARGET_CLEARANCE : target).toPrecision(8)),
    risk: parseFloat(risk.toPrecision(8)),
    riskPct: parseFloat(((risk / entry) * 100).toFixed(3)),
    rr: parseFloat(rr.toFixed(2)),
    targetSource: usePool ? 'LIQUIDITY_POOL' : 'STRUCTURAL_MIN',
  };
};

// ── THE STATE MACHINE ─────────────────────────────────────────────────────────
/**
 * evaluateICT(candles, { symbol, now }) → structured JSON for the dashboard.
 *
 * {
 *   symbol, ts, state, bias, killzone, tradeable,
 *   sweep: { dir, level, extreme, ageBars } | null,
 *   mss:   { mssLevel, bodyAtrMult, ageBars } | null,
 *   fvg:   { bottom, top, ce, mitigatedPct, ... } | null,
 *   setup: { direction, entry, stop, target, rr } | null,
 *   missing, narrative
 * }
 *
 * States (strict hierarchy):
 *   [SCANNING_SWEEP]        hunting the raid — or raid taken, waiting displacement
 *   [DISPLACEMENT_DETECTED] MSS confirmed — waiting for a clean FVG
 *   [FVG_MITIGATION]        FVG live — price returning to the zone
 *   [WAITING_FOR_KILLZONE]  structure complete — parked until a window opens
 *   [EXECUTING]             killzone open + price at/into the FVG → arm the trade
 */
export const evaluateICT = (candles, { symbol = null, now = Date.now() } = {}) => {
  const kz = killzoneState(now);
  const out = {
    symbol, ts: now, strategy: 'ICT_PRECISION', state: 'SCANNING_SWEEP', bias: 'NEUTRAL', tradeable: false,
    killzone: kz, sweep: null, mss: null, fvg: null, setup: null,
    structId: null, missing: null, narrative: '',
  };
  const park = (state, missing, narrative) => { out.state = state; out.missing = missing; out.narrative = narrative; return out; };

  if (!candles || candles.length < 60) {
    return park('SCANNING_SWEEP', 'candle history (warming up)',
      'Insufficient candle history to evaluate structure — still warming up.');
  }
  const bars = candles.length > ICT.LOOKBACK ? candles.slice(-ICT.LOOKBACK) : candles;
  const atr = calculateATR(bars, 14);
  if (!(atr > 0)) {
    return park('SCANNING_SWEEP', 'volatility baseline (ATR unavailable)',
      'ATR baseline not ready — cannot measure displacement yet.');
  }

  // STEP A — liquidity sweep
  const swings = findSwings(bars, 0, ICT.SWING_STRENGTH);
  const raid = detectRaid(bars, swings, atr);
  const sym = symbol ? symbol.split('-')[0] : 'ASSET';
  if (!raid) {
    return park('SCANNING_SWEEP', 'liquidity sweep — no recent raid of a swing high/low',
      `No liquidity raid in the last ${ICT.SWEEP_MAX_AGE} bars — hunting swing highs/lows for a sweep.`);
  }
  out.bias = raid.dir;
  out.sweep = {
    dir: raid.dir, level: raid.level, extreme: raid.extreme,
    ageBars: raid.ageBars, time: raid.time,
  };
  const sweptSide = raid.dir === 'BULLISH' ? 'sell-side' : 'buy-side';

  // STEP B — displacement / MSS
  const disp = detectDisplacement(bars, atr, raid, swings);
  if (!disp) {
    return park('SCANNING_SWEEP', 'displacement — liquidity taken, no qualifying MSS candle yet',
      `${sym}: swept ${sweptSide} liquidity at ${fmtPrice(raid.level)} (${raid.ageBars} bars ago) — waiting for displacement (MSS).`);
  }
  out.mss = {
    dir: disp.dir, mssLevel: disp.mssLevel, bodyAtrMult: disp.bodyAtrMult,
    ageBars: disp.ageBars, time: disp.time,
  };

  // STEP C — fair value gap
  const fvg = detectFVG(bars, disp, atr);
  if (!fvg) {
    return park('DISPLACEMENT_DETECTED', 'fair value gap — no clean FVG imprinted by the displacement leg',
      `${sym}: displacement confirmed (${disp.bodyAtrMult}× ATR body, MSS through ${fmtPrice(disp.mssLevel)}) — waiting for a clean FVG to form.`);
  }
  const mit = trackFVG(bars, fvg);
  out.fvg = {
    dir: fvg.dir, bottom: fvg.bottom, top: fvg.top, ce: fvg.ce,
    sizePct: fvg.sizePct, ageBars: mit.ageBars,
    mitigatedPct: mit.mitigatedPct, edgeTapped: mit.edgeTapped,
    ceTapped: mit.ceTapped, inZone: mit.inZone, invalidated: mit.invalidated,
    time: fvg.time,
  };
  const zone = `${fmtPrice(fvg.top)}–${fmtPrice(fvg.bottom)} (CE ${fmtPrice(fvg.ce)})`;

  if (mit.invalidated) {
    return park('DISPLACEMENT_DETECTED', 'clean FVG — prior gap invalidated by a close through it',
      `${sym}: FVG ${zone} was invalidated by a close through the zone — structure voided, re-hunting.`);
  }

  const bullish = fvg.dir === 'BULLISH';

  // Wait: structure complete but no qualifying entry moment yet
  if (!mit.edgeTapped && !mit.inZone) {
    if (kz.active && bullish) {
      return park('FVG_MITIGATION', `price retrace into FVG ${zone}`,
        `${sym}: ${sweptSide} liquidity swept at ${fmtPrice(raid.level)}, displacement ${disp.bodyAtrMult}× ATR (MSS ${fmtPrice(disp.mssLevel)}) — price retracing toward FVG ${zone}; waiting for the tap.`);
    }
    if (!bullish) {
      return park('FVG_MITIGATION', 'long-side framework (bearish MSS — desk is long-only)',
        `${sym}: bearish structure live — FVG ${zone} above price. Desk is long-only; standing down.`);
    }
  }

  // Killzone gate — structure armed but the window is shut.
  // The `missing` field stays static (label only — no countdown) so telemetry
  // transitions fire once, while the narrative may carry the live countdown.
  if (!kz.active && bullish) {
    const nextLabel = kz.next ? kz.next.label : 'next window';
    const nextTxt = kz.next ? `${nextLabel} in ~${kz.next.startsInMin}m` : 'next window';
    return park('WAITING_FOR_KILLZONE', `killzone window — next ${nextLabel}`,
      `${sym}: structure complete (sweep ${fmtPrice(raid.level)} → MSS ${fmtPrice(disp.mssLevel)} → FVG ${zone}); parked for the next killzone — ${nextTxt}.`);
  }

  if (!bullish) {
    return park('FVG_MITIGATION', 'long-side framework (bearish MSS — desk is long-only)',
      `${sym}: bearish structure live, price mitigating FVG ${zone} — no short side on this desk; standing down.`);
  }

  // Entry moment: price at the zone now, or the CE was tapped within the freshness window
  const barsSinceTap = mit.ceIdx != null ? bars.length - 1 - mit.ceIdx : null;
  const freshTap = mit.ceTapped && barsSinceTap != null && barsSinceTap <= ICT.TAP_FRESH_BARS;
  const setup = buildSetup(atr, raid, fvg, swings);
  if (mit.inZone || freshTap) {
    if (!setup) {
      return park('FVG_MITIGATION', `entry bracket — risk geometry outside officer windows for FVG ${zone}`,
        `${sym}: price mitigating FVG ${zone} but the risk bracket does not respect the officer windows.`);
    }
    out.setup = setup;
    out.tradeable = true;
    out.structId = `${symbol || sym}:${raid.time}:${fvg.time}`;
    return park('EXECUTING', null,
      `${sym}: [EXECUTING] ${kz.label} open — sweep ${fmtPrice(raid.level)}, MSS ${fmtPrice(disp.mssLevel)}, price mitigating FVG ${zone}. Bracket: entry ${fmtPrice(setup.entry)} · stop ${fmtPrice(setup.stop)} · target ${fmtPrice(setup.target)} (${setup.rr}R, ${setup.riskPct}% risk).`);
  }

  // CE tapped but stale, price left the zone — the setup is spent
  if (mit.ceTapped) {
    return park('SCANNING_SWEEP', 'fresh raid — prior FVG already consumed (CE tapped)',
      `${sym}: prior FVG ${zone} was already tapped and price has left the zone — setup spent, hunting a fresh raid.`);
  }

  return park('FVG_MITIGATION', `price retrace into FVG ${zone}`,
    `${sym}: FVG ${zone} live (${mit.mitigatedPct * 100}% mitigated) — waiting for price to reach the entry area.`);
};
