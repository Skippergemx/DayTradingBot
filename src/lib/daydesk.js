// ── DAY DESK ENGINE (two validated intraday desks, pure & deterministic) ──────
// Mode D of Vio8's desk family — the day-trading desks discovered by
// scripts/research-day.mjs and frozen after split-half validation on a
// crash-containing 120d tape AND the recent 50d tape (both halves profitable):
//
//   DAY_BREAKOUT     "NR7v6 f2 d10"  — 15m NR7 compression → 1m close breaks
//                    the narrow bucket's high (≤ +0.4% leash) on a strong
//                    close + ≥1.5× bucket volume, inside BTC bull + a rising
//                    per-symbol 4H EMA20 structure. Stop clamped 2.0–2.5×ATR15,
//                    target 4R, time stop 12h, static stop (no trail).
//                    120d: 146t WR 33.6% PF 1.23 +$308 · 50d: 63t WR 41.3% PF 1.75 +$480
//   DAY_CAPITULATION "RSI2v7 rsi<2 cd360 d10r" — 15m RSI(2) < 2 capitulation
//                    in a 1h uptrend (close > EMA100, EMA50 rising) + symbol
//                    4H up + ATR% floor + ≥1.5× volume. Stop 2.5×ATR15, pure
//                    peak ratchet trail (2.5×ATR, armed +0.5R), time stop 8h,
//                    6h post-stop cooldown.
//                    120d: 212t WR 42.5% PF 1.18 +$268 · 50d: 113t WR 46.9% PF 1.41 +$373
//
// The two desks are regime-complementary (capitulation thrives in crashes,
// breakout in expansions) but must NOT share a slot pool — the round-7 MIX
// replays showed merged books displace each other's winners. In the app each
// desk is its own selectable strategy for exactly that reason.
//
// PORT DISCIPLINE — every series/threshold mirrors scripts/research-day.mjs
// line-for-line (same Wilder seeds, same inclusive SMA, same last-completed-
// bucket reads, same clamps). The only live substitutions, all conservative:
//   · entry = live price × 1.0002        (bakes in the research 2bp slip)
//   · RSI2 target = 8R nominal           (research = trail-only; 8R almost never binds)
//   · EMA100/50 + 4H EMA20 warm from the 1000-bar 1H day plane (residual below float noise)
//   · exit polling at ~1.5s instead of 1m bars (finer, same semantics)
//   · `gates` telemetry (the full checklist for the mover ledger) is additive
//     and never read by the decision path — the park() strings stay verbatim
//
// Same contract as evaluateICT: pure JSON out,
// no side effects, Node-importable for headless verification.

// ── TUNING (frozen research winners — do not drift without re-running the lab) ─
export const DAYDESK = {
  SLIP: 0.0002,              // research per-fill slippage, baked into the entry
  EXPIRE_MS: 5 * 60 * 1000,  // resting bid lifetime if the tape runs away
  MIN_15M_BARS: 100,         // Wilder ATR(14) convergence needs ~100 buckets
  MIN_1H_BARS: 130,          // EMA100 seed + slope room from the day 1H plane
  MIN_4H_BUCKETS: 24,        // EMA20_4h seed at 19 + slope at 20
  MIN_DAILY_BARS: 15,        // BTC SMA10 + the d-3 rising check

  NR7: {
    WINDOW: 7,               // narrowest of the last 7 buckets
    LEASH: 1.004,            // breakout close ≤ +0.4% past the bucket high
    CLOSE_STRENGTH: 0.6,     // 1m signal bar closes ≥60% of its own range
    VOL_MULT: 1.5,           // bucket volume ≥ 1.5× the 20-bucket average
    VOL_MA: 20,
    STOP_MIN_ATR: 2.0,       // stop = clamp(close − bucketLow, 2.0–2.5×ATR15)
    STOP_MAX_ATR: 2.5,
    TARGET_R: 4,             // resting 4R limit
    TIME_STOP_MIN: 12 * 60,  // flat by 12h — the research time exit
  },

  RSI2: {
    THRESHOLD: 2,            // 15m RSI(2) < 2
    STOP_ATR: 2.5,
    TRAIL_ATR: 2.5,          // pure peak ratchet, research manageBar semantics
    ARM_R: 0.5,              // ratchet arms once peak ≥ +0.5R
    TARGET_R: 8,             // nominal ceiling — the trail governs
    MIN_ATR_PCT: 0.002,      // ATR15/price floor
    VOL_MULT: 1.5,
    TIME_STOP_MIN: 8 * 60,
    COOLDOWN_MIN: 360,       // 6h post-stop-out per symbol (research cd360)
  },
};

export const DAY_STATES = ['DAY_HUNTING', 'DAY_COMPRESSION', 'DAY_EXECUTING'];

// ── INDICATOR SERIES — exact mirrors of scripts/research-day.mjs ──────────────
const smaSeries = (vals, period) => {
  const n = vals.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
};

const emaSeries = (vals, period) => {
  const n = vals.length;
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += vals[i];
  let e = sum / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
};

const rsiSeries = (closes, period) => {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
};

const atrSeries = (h, l, c, period) => {
  const n = c.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < n; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
};

// ── BUCKET HELPERS ────────────────────────────────────────────────────────────
/** Bars whose bucket has fully closed at `now` (research lastDone semantics). */
const closedBars = (bars, ms, now) => (
  Array.isArray(bars) ? bars.filter(b => b && Number.isFinite(b.time) && b.time + ms <= now) : []
);

/** Fold completed 1H bars into completed 4H buckets (floor-aligned, exact). */
const fold4h = (bars, now) => {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.time / 14400e3) * 14400e3;
    const last = out[out.length - 1];
    if (!last || last.time !== t) {
      out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    } else {
      if (b.high > last.high) last.high = b.high;
      if (b.low < last.low) last.low = b.low;
      last.close = b.close;
      last.volume += b.volume || 0;
    }
  }
  return out.filter(b => b.time + 14400e3 <= now);
};

/** EMA slope in percent — (e[i]/e[i-1]-1)*100, 0 when degenerate (research). */
const slopePct = (series, i) => (
  i >= 1 && Number.isFinite(series[i]) && Number.isFinite(series[i - 1]) && series[i - 1] > 0
    ? (series[i] / series[i - 1] - 1) * 100
    : 0
);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const p8 = (x) => parseFloat(x.toPrecision(8));
const fmt = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
};

// ── CONTEXT (regime + per-symbol structure + 15m series) ──────────────────────
/**
 * Builds everything both desks read, from COMPLETED data only. Regime flags
 * mirror research attachContext:
 *   btcUp   — BTC 1h close > EMA100 && EMA50 slope > 0 (last completed hour)
 *   btcD10  — BTC close > SMA10 of completed daily closes
 *   btcD10r — btcD10 + SMA10 rising vs 3 completed days ago
 *   btcTrendGate — round-12 switch (default true): false bypasses the two
 *               trend reads (btcUp, btcD10r); btcD10 and every asset gate stand.
 */
const buildContext = (bars15, { now, price, bars1h, btcBars1h, btcDaily, bar1m, btcTrendGate = true }) => {
  const done15 = closedBars(bars15, 900e3, now);
  if (done15.length < DAYDESK.MIN_15M_BARS) {
    return { warm: `15m history (${done15.length}/${DAYDESK.MIN_15M_BARS} buckets)` };
  }

  const closes15 = done15.map(b => b.close);
  const highs15 = done15.map(b => b.high);
  const lows15 = done15.map(b => b.low);
  const vols15 = done15.map(b => b.volume || 0);
  const atr15 = atrSeries(highs15, lows15, closes15, 14);
  const volAvg15 = smaSeries(vols15, DAYDESK.NR7.VOL_MA);
  const rsi2_15 = rsiSeries(closes15, 2);
  const nb = done15.length - 1;

  // BTC 1h uptrend (from the swing book's completed hours)
  const btc1h = closedBars(btcBars1h, 3600e3, now);
  let btcUp = false;
  if (btc1h.length >= DAYDESK.MIN_1H_BARS) {
    const cb = btc1h.map(b => b.close);
    const e100 = emaSeries(cb, 100);
    const e50 = emaSeries(cb, 50);
    const bi = btc1h.length - 1;
    btcUp = bi >= 100 && Number.isFinite(e100[bi]) && cb[bi] > e100[bi] && slopePct(e50, bi) > 0;
  }

  // BTC daily regime
  const btcD = closedBars(btcDaily, 86400e3, now);
  let btcD10 = false, btcD10r = false;
  if (btcD.length >= DAYDESK.MIN_DAILY_BARS) {
    const dc = btcD.map(b => b.close);
    const sma10 = smaSeries(dc, 10);
    const bd = btcD.length - 1;
    btcD10 = bd >= 9 && Number.isFinite(sma10[bd]) && dc[bd] > sma10[bd];
    btcD10r = btcD10 && bd >= 12 && Number.isFinite(sma10[bd - 3]) && sma10[bd] > sma10[bd - 3];
  }

  // Per-symbol 1h trend + 4H structure (from the swing book)
  const sym1h = closedBars(bars1h, 3600e3, now);
  let trendUp = false, sym4hUp = false, h1Ready = sym1h.length >= DAYDESK.MIN_1H_BARS, h4Ready = false;
  if (h1Ready) {
    const c1 = sym1h.map(b => b.close);
    const e100 = emaSeries(c1, 100);
    const e50 = emaSeries(c1, 50);
    const hi = sym1h.length - 1;
    trendUp = hi >= 100 && Number.isFinite(e100[hi]) && c1[hi] > e100[hi] && slopePct(e50, hi) > 0;

    const b4 = fold4h(sym1h, now);
    h4Ready = b4.length >= DAYDESK.MIN_4H_BUCKETS;
    if (h4Ready) {
      const c4 = b4.map(b => b.close);
      const e20 = emaSeries(c4, 20);
      const h4 = b4.length - 1;
      sym4hUp = h4 >= 20 && Number.isFinite(e20[h4]) && c4[h4] > e20[h4] && slopePct(e20, h4) > 0;
    }
  }

  return {
    done15, nb, atr15, volAvg15, rsi2_15,
    btcUp, btcD10, btcD10r, btcTrendGate, trendUp, sym4hUp, h1Ready, h4Ready,
    bar1m: bar1m && Number.isFinite(bar1m.close) ? bar1m : null,
    priceNow: Number.isFinite(price) && price > 0 ? price
      : (bar1m && Number.isFinite(bar1m.close) ? bar1m.close : done15[nb].close),
  };
};

const baseOut = (strategy, symbol, now) => ({
  symbol, ts: now, strategy, state: 'DAY_HUNTING', bias: 'NEUTRAL', tradeable: false,
  regime: null, gates: null, zone: null, compression: null, oversold: null,
  setup: null, structId: null, missing: null, narrative: '',
});

// ── VERIFICATION HOOK — the exact context the desks read, for the headless
// port-fidelity checker (scripts/verify-daydesk.mjs). Pure, unused by the app.
export const dayContextOf = (bars15, opts) => buildContext(bars15, opts);

const park = (out, state, missing, narrative) => {
  out.state = state; out.missing = missing; out.narrative = narrative; return out;
};

const regimeOf = (c) => ({ btcUp: c.btcUp, btcD10: c.btcD10, btcD10r: c.btcD10r, btcTrendBypass: !c.btcTrendGate });

const regimeOk = (out, c, desk) => {
  const sym = out.symbol.split('-')[0];
  out.regime = regimeOf(c);
  // Round-12 switch: btcTrendGate=false bypasses the two trend parks (btcUp,
  // btcD10r) — btcD10 and every asset gate still stand, and gateScan marks the
  // bypassed rows 'bypass' so first-fail telemetry still matches the park string.
  if (c.btcTrendGate && !c.btcUp) {
    return park(out, 'DAY_HUNTING', 'BTC 1h uptrend (close > EMA100, EMA50 rising)',
      `${sym}: BTC is not in a 1h uptrend — the day desk only longs with the king.`);
  }
  if (!c.btcD10) {
    return park(out, 'DAY_HUNTING', 'BTC daily regime (close > daily SMA10)',
      `${sym}: BTC closed under its daily SMA10 — day-longs lack the daily wind.`);
  }
  if (desk === 'RSI2' && c.btcTrendGate && !c.btcD10r) {
    return park(out, 'DAY_HUNTING', 'BTC daily SMA10 rising',
      `${sym}: BTC SMA10 is not rising — capitulation bids wait for a healing daily.`);
  }
  return null;
};

// ── GATE TELEMETRY — the same ordered checklist, never short-circuited ────────
// The desks park at the FIRST unmet gate and that string stays `missing` —
// byte-identical to the research port. This scan walks the same gates to the
// END so the mover ledger can tell each asset's own story even while a
// DESK-WIDE regime gate (BTC) is every row's first stop. Pure telemetry: it
// never touches state/tradeable/setup, and every read is guarded. Round-12:
// when the btcTrendGate switch is off, the btcUp (and, for RSI2, btcD10r)
// rows read ok:'bypass'.
const gateOf = (id, ok, note) => (note != null ? { id, ok: Boolean(ok), note } : { id, ok: Boolean(ok) });

const gateScan = (c, desk) => {
  const { done15, nb, atr15, volAvg15, rsi2_15 } = c;
  const bucket = done15[nb];
  const atr = atr15[nb];
  const volRatio = volAvg15[nb] > 0 ? bucket.volume / volAvg15[nb] : 0;

  if (desk === 'RSI2') {
    const R = DAYDESK.RSI2;
    const rsi2 = rsi2_15[nb];
    const c1m = c.bar1m ? c.bar1m.close : c.priceNow;
    const atrPct = Number.isFinite(atr) && c1m > 0 ? atr / c1m : NaN;
    return [
      gateOf('btcUp', c.btcUp || !c.btcTrendGate, !c.btcTrendGate ? 'bypass' : undefined),
      gateOf('btcD10', c.btcD10),
      gateOf('btcD10r', c.btcD10r || !c.btcTrendGate, !c.btcTrendGate ? 'bypass' : undefined),
      gateOf('h1', c.h1Ready),
      gateOf('s4h', c.sym4hUp),
      gateOf('t1h', c.trendUp),
      gateOf('rsi2', Number.isFinite(rsi2) && rsi2 < R.THRESHOLD, Number.isFinite(rsi2) ? rsi2.toFixed(1) : '—'),
      gateOf('atrFloor', atr > 0 && atrPct >= R.MIN_ATR_PCT, Number.isFinite(atrPct) ? `${(atrPct * 100).toFixed(2)}%` : '—'),
      gateOf('vol', volAvg15[nb] > 0 && bucket.volume >= R.VOL_MULT * volAvg15[nb], `${volRatio.toFixed(2)}×`),
    ];
  }

  const N = DAYDESK.NR7;
  const range = bucket.high - bucket.low;
  let nr7 = range > 0;
  for (let j = nb - 6; nr7 && j < nb; j++) if (done15[j].high - done15[j].low <= range) nr7 = false;
  const level = bucket.high;
  const b1 = c.bar1m;
  const rng1 = b1 ? b1.high - b1.low : 0;
  const rangePct = bucket.close > 0 ? (range / bucket.close) * 100 : NaN;
  return [
    gateOf('btcUp', c.btcUp || !c.btcTrendGate, !c.btcTrendGate ? 'bypass' : undefined),
    gateOf('btcD10', c.btcD10),
    gateOf('h4ready', c.h1Ready && c.h4Ready),
    gateOf('s4h', c.sym4hUp),
    gateOf('nr7', nr7, Number.isFinite(rangePct) ? `${rangePct.toFixed(2)}%` : '—'),
    gateOf('vol', volAvg15[nb] > 0 && bucket.volume >= N.VOL_MULT * volAvg15[nb], `${volRatio.toFixed(2)}×`),
    gateOf('atrReady', atr > 0),
    gateOf('bar1m', Boolean(b1)),
    gateOf('above', Boolean(b1) && b1.close > level, fmt(level)),
    gateOf('leash', Boolean(b1) && b1.close > level && b1.close <= level * N.LEASH),
    gateOf('strong', Boolean(b1) && rng1 > 0 && (b1.close - b1.low) / rng1 >= N.CLOSE_STRENGTH),
  ];
};

// ── DESK 1: NR7 BREAKOUT ──────────────────────────────────────────────────────
export const evaluateDayBreakout = (bars15, { symbol = null, now = Date.now(), price = null, bars1h = null, btcBars1h = null, btcDaily = null, bar1m = null, btcTrendGate = true } = {}) => {
  const out = baseOut('DAY_BREAKOUT', symbol, now);
  const sym = symbol ? symbol.split('-')[0] : 'ASSET';
  const c = buildContext(bars15, { symbol, now, price, bars1h, btcBars1h, btcDaily, bar1m, btcTrendGate });
  if (c.warm) return park(out, 'DAY_HUNTING', c.warm, `${sym}: day-breakout engine warming up — gathering 15m compression.`);
  out.gates = gateScan(c, 'NR7'); // additive telemetry — the decision path below is untouched
  out.regime = regimeOf(c);

  const hold = regimeOk(out, c, 'NR7');
  if (hold) return hold;

  if (!c.h1Ready || !c.h4Ready) {
    return park(out, 'DAY_HUNTING', '4H structure (1H swing book warming up)',
      `${sym}: 4H structure not ready — the swing book is still folding hours.`);
  }
  if (!c.sym4hUp) {
    return park(out, 'DAY_HUNTING', '4H structure — close > rising EMA20',
      `${sym}: 4H close is under a flat/falling EMA20 — breakouts fail in local downtrends; standing down.`);
  }

  const { done15, nb, atr15, volAvg15 } = c;
  const N = DAYDESK.NR7;
  const bucket = done15[nb];
  const range = bucket.high - bucket.low;
  const atr = atr15[nb];

  // NR7: the latest COMPLETED bucket is the narrowest of the last 7.
  let nr7 = range > 0;
  for (let j = nb - 6; nr7 && j < nb; j++) if (done15[j].high - done15[j].low <= range) nr7 = false;
  if (!nr7) {
    return park(out, 'DAY_HUNTING', 'NR7 compression — no 7-bucket range low',
      `${sym}: waiting for a bucket that compresses tighter than the prior six (no NR7 in the completed window).`);
  }

  const level = bucket.high;
  const rangePct = (range / bucket.close) * 100;
  const volRatio = volAvg15[nb] > 0 ? bucket.volume / volAvg15[nb] : 0;
  out.zone = { kind: 'NR7_BREAK', bottom: p8(bucket.low), top: p8(level), level: p8(level), entry: p8(level) };
  out.compression = {
    time: bucket.time, low: p8(bucket.low), high: p8(level),
    rangePct: +rangePct.toFixed(2), volRatio: +volRatio.toFixed(2), ageBars: 0,
  };

  const bucketTxt = `${fmt(bucket.low)}–${fmt(level)} (NR7, ${rangePct.toFixed(2)}% range, ${volRatio.toFixed(2)}× vol)`;
  out.bias = 'BULLISH';

  if (!(volAvg15[nb] > 0) || !(bucket.volume >= N.VOL_MULT * volAvg15[nb])) {
    return park(out, 'DAY_COMPRESSION', `volume ignition — bucket at ${volRatio.toFixed(2)}× (need ≥ ${N.VOL_MULT}×)`,
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — volume has not ignited yet.`);
  }
  if (!(atr > 0)) {
    return park(out, 'DAY_COMPRESSION', '15m ATR (unavailable)',
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — ATR not ready for the risk clamp.`);
  }
  const b1 = c.bar1m;
  if (!b1) {
    return park(out, 'DAY_COMPRESSION', '1m tape (waiting for a completed signal bar)',
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — waiting for the 1m tape.`);
  }
  if (!(b1.close > level)) {
    return park(out, 'DAY_COMPRESSION', `breakout — 1m close above ${fmt(level)}`,
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — bidding the break of ${fmt(level)}; no 1m close above it yet.`);
  }
  if (!(b1.close <= level * N.LEASH)) {
    return park(out, 'DAY_COMPRESSION', 'entry leash — price ran > 0.4% past the level',
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — price ran more than the 0.4% leash past ${fmt(level)}; the move is already extended.`);
  }
  const rng1 = b1.high - b1.low;
  if (!(rng1 > 0) || (b1.close - b1.low) / rng1 < N.CLOSE_STRENGTH) {
    return park(out, 'DAY_COMPRESSION', 'strong 1m close (≥60% of the signal bar)',
      `${sym}: [DAY_COMPRESSION] ${bucketTxt} — the breakout bar must CLOSE strong, not wick up.`);
  }

  const stopDist = clamp(b1.close - bucket.low, N.STOP_MIN_ATR * atr, N.STOP_MAX_ATR * atr);
  const entry = c.priceNow * (1 + DAYDESK.SLIP);
  const stop = entry - stopDist;
  const target = entry + N.TARGET_R * stopDist;
  const riskPct = (stopDist / entry) * 100;

  out.setup = {
    direction: 'LONG',
    entry: p8(entry), stop: p8(stop), target: p8(target),
    risk: p8(stopDist), riskPct: +riskPct.toFixed(3), rr: N.TARGET_R,
    targetSource: 'NR7_MEASURED_4R',
    trail: { mode: 'NONE' }, // validated exit: static stop / 4R limit / 12h time
  };
  out.tradeable = true;
  out.structId = `${symbol || sym}:NR7:${bucket.time}`;
  return park(out, 'DAY_EXECUTING', null,
    `${sym}: [DAY_EXECUTING] NR7 ${bucketTxt} broke ${fmt(level)} on a strong 1m close — bracket: entry ${fmt(entry)} · stop ${fmt(stop)} · target ${fmt(target)} (${N.TARGET_R}R, ${riskPct.toFixed(2)}% risk, 12h time stop).`);
};

// ── DESK 2: RSI(2) CAPITULATION ───────────────────────────────────────────────
export const evaluateDayCapitulation = (bars15, { symbol = null, now = Date.now(), price = null, bars1h = null, btcBars1h = null, btcDaily = null, bar1m = null, btcTrendGate = true } = {}) => {
  const out = baseOut('DAY_CAPITULATION', symbol, now);
  const sym = symbol ? symbol.split('-')[0] : 'ASSET';
  const c = buildContext(bars15, { symbol, now, price, bars1h, btcBars1h, btcDaily, bar1m, btcTrendGate });
  if (c.warm) return park(out, 'DAY_HUNTING', c.warm, `${sym}: day-capitulation engine warming up — folding 15m pivots.`);
  out.gates = gateScan(c, 'RSI2'); // additive telemetry — the decision path below is untouched
  out.regime = regimeOf(c);

  const hold = regimeOk(out, c, 'RSI2');
  if (hold) return hold;

  if (!c.h1Ready) {
    return park(out, 'DAY_HUNTING', '1H trend (swing book warming up)',
      `${sym}: 1H trend not ready — the swing book is still folding hours.`);
  }
  if (!c.sym4hUp) {
    return park(out, 'DAY_HUNTING', '4H structure — close > rising EMA20',
      `${sym}: 4H close is under a flat/falling EMA20 — knife-catches are for markets in uptrends; standing down.`);
  }
  if (!c.trendUp) {
    return park(out, 'DAY_HUNTING', '1H uptrend (close > EMA100, EMA50 rising)',
      `${sym}: no 1H uptrend — capitulation bids need the higher-timeframe wind at their back.`);
  }

  const { done15, nb, atr15, volAvg15, rsi2_15 } = c;
  const R = DAYDESK.RSI2;
  const bucket = done15[nb];
  const rsi2 = rsi2_15[nb];
  const atr = atr15[nb];
  const volRatio = volAvg15[nb] > 0 ? bucket.volume / volAvg15[nb] : 0;

  if (!(rsi2 < R.THRESHOLD)) {
    return park(out, 'DAY_HUNTING', `oversold — 15m RSI(2) < ${R.THRESHOLD} (last ${Number.isFinite(rsi2) ? rsi2.toFixed(1) : '—'})`,
      `${sym}: hunting capitulation — 15m RSI(2) at ${Number.isFinite(rsi2) ? rsi2.toFixed(1) : '—'} (need < ${R.THRESHOLD}).`);
  }

  out.oversold = {
    time: bucket.time, rsi2: Number.isFinite(rsi2) ? +rsi2.toFixed(1) : null,
    volRatio: +volRatio.toFixed(2),
  };
  out.bias = 'BULLISH';
  const pivotTxt = `RSI(2) ${rsi2.toFixed(1)} at ${fmt(bucket.close)}`;

  if (!(atr > 0)) {
    return park(out, 'DAY_COMPRESSION', '15m ATR (unavailable)',
      `${sym}: [DAY_COMPRESSION] ${pivotTxt} — ATR not ready.`);
  }
  const c1m = c.bar1m ? c.bar1m.close : c.priceNow;
  if (!(atr / c1m >= R.MIN_ATR_PCT)) {
    return park(out, 'DAY_COMPRESSION', `volatility floor — ATR/price ≥ ${R.MIN_ATR_PCT * 100}%`,
      `${sym}: [DAY_COMPRESSION] ${pivotTxt} — the tape is too quiet to pay the fees.`);
  }
  if (!(volAvg15[nb] > 0) || !(bucket.volume >= R.VOL_MULT * volAvg15[nb])) {
    return park(out, 'DAY_COMPRESSION', `climax volume — bucket at ${volRatio.toFixed(2)}× (need ≥ ${R.VOL_MULT}×)`,
      `${sym}: [DAY_COMPRESSION] ${pivotTxt} — the flush needs climax volume to mark a low.`);
  }

  const stopDist = R.STOP_ATR * atr;
  const entry = c.priceNow * (1 + DAYDESK.SLIP);
  const stop = entry - stopDist;
  const target = entry + R.TARGET_R * stopDist; // nominal ceiling — the trail governs
  const riskPct = (stopDist / entry) * 100;

  out.setup = {
    direction: 'LONG',
    entry: p8(entry), stop: p8(stop), target: p8(target),
    risk: p8(stopDist), riskPct: +riskPct.toFixed(3), rr: R.TARGET_R,
    targetSource: 'TRAIL_RATCHET',
    trail: {
      mode: 'RATCHET',       // pure peak ratchet (research manageBar — no BE jump)
      atr: p8(atr),
      dist: p8(R.TRAIL_ATR * atr),
      armR: R.ARM_R,
    },
  };
  out.tradeable = true;
  out.structId = `${symbol || sym}:RSI2:${bucket.time}`;
  return park(out, 'DAY_EXECUTING', null,
    `${sym}: [DAY_EXECUTING] ${pivotTxt} in a 1H uptrend (${volRatio.toFixed(2)}× volume) — bracket: entry ${fmt(entry)} · stop ${fmt(stop)} · target ${fmt(target)} (tilting on a 2.5×ATR ratchet armed at +${R.ARM_R}R, 8h time stop).`);
};
