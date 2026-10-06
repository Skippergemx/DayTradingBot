// ── DAYDESK PORT-FIDELITY VERIFIER ────────────────────────────────────────────
// Replays the RESEARCH harness's per-minute "body-ok" signal log (dumped by
// research-day.mjs --dump-signals) through the PRODUCTION module
// src/lib/daydesk.js, fed EXACTLY the data the live app feeds it:
//   · 300×15m completed buckets   (folded here from the 1m cache)
//   · 1000×1h completed hours     (the live day trend plane)
//   · 30×1d completed days        (BTC regime window)
//   · the last completed 1m bar at each decision minute
//
// For every logged minute it asserts:
//   research fired  ⇔  daydesk fires (DAY_EXECUTING)
//   and when both fire, that the geometry (stop/risk, target, trail, armR)
//   matches the research plan to float precision.
//
// A reversal walk (every minute on the busiest symbols) proves the production
// module never fires outside the logged body-ok set — i.e. the dump lost
// nothing.
//
// Usage:
//   node scripts/verify-daydesk.mjs --dump backtest-reports/day-signals.json
//     [--walk-count 3] [--walk-days 30] [--max-detail 40]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINANCE_MAP, BINANCE_SKIP } from '../src/lib/universe.js';
import { evaluateDayBreakout, evaluateDayCapitulation, dayContextOf } from '../src/lib/daydesk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CFG = { dump: null, walkCount: 3, walkDays: 30, maxDetail: 40 };
const args = process.argv.slice(2);
for (let a = 0; a < args.length; a++) {
  const key = args[a]?.replace(/^--/, '');
  const val = args[++a];
  if (key == null || val == null) { console.warn(`Missing value for --${key}`); break; }
  switch (key) {
    case 'dump': CFG.dump = val; break;
    case 'walk-count': CFG.walkCount = Math.max(0, Number(val) | 0); break;
    case 'walk-days': CFG.walkDays = Math.max(1, Number(val)); break;
    case 'max-detail': CFG.maxDetail = Math.max(4, Number(val) | 0); break;
    default: console.warn(`Unknown flag: --${key}`);
  }
}
if (!CFG.dump) { console.error('Usage: node scripts/verify-daydesk.mjs --dump <day-signals.json>'); process.exit(1); }

const GATE_NAMES = ['btcUp', 'btcD10', 'btcD10r', 'trendUp', 'sym4hUp'];
const bitNames = (bits) => GATE_NAMES.filter((_, i) => (bits >> i) & 1);

// ── CACHE LOADING → typed arrays (memory-tight) ───────────────────────────────
const cacheFile = (sym) => {
  const base = sym.split('-')[0];
  if (BINANCE_SKIP.includes(base)) return null;
  return path.join(ROOT, '.backtest-cache', `1m_${(BINANCE_MAP[base] || base)}USDT.json`);
};
const loadRows = (sym) => {
  const f = cacheFile(sym);
  if (!f || !fs.existsSync(f)) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const n = raw.length;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    t[i] = r[0]; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5];
  }
  return { t, o, h, l, c, v, n };
};

// ── BUCKET FOLDING (research foldBuckets semantics, object form) ──────────────
const fold = (rows, ms) => {
  const out = [];
  let cur = -1;
  for (let i = 0; i < rows.n; i++) {
    const b = Math.floor(rows.t[i] / ms);
    if (b !== cur) {
      cur = b;
      out.push({ time: b * ms, open: rows.o[i], high: rows.h[i], low: rows.l[i], close: rows.c[i], volume: rows.v[i] });
    } else {
      const L = out[out.length - 1];
      if (rows.h[i] > L.high) L.high = rows.h[i];
      if (rows.l[i] < L.low) L.low = rows.l[i];
      L.close = rows.c[i];
      L.volume += rows.v[i];
    }
  }
  return out;
};

// ── SMALL HELPERS ─────────────────────────────────────────────────────────────
const idxExact = (tArr, time) => {           // exact minute index or -1
  let lo = 0, hi = tArr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = tArr[mid];
    if (x === time) return mid;
    if (x < time) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
};
const idxLastComplete = (buckets, ms, now) => { // last bucket with time+ms <= now
  let lo = 0, hi = buckets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid].time + ms <= now) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
};
const sliceBack = (objs, endIdx, count) => objs.slice(Math.max(0, endIdx + 1 - count), endIdx + 1);
const relErr = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
const packBits = (c) => (c.btcUp ? 1 : 0) | (c.btcD10 ? 2 : 0) | (c.btcD10r ? 4 : 0) | (c.trendUp ? 8 : 0) | (c.sym4hUp ? 16 : 0);
const utc = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

// Local EMA copy — research/desk window math, used ONLY to explain mismatches.
const emaLocal = (vals, period) => {
  const n = vals.length, out = new Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += vals[i];
  let e = sum / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
};

// ── MAIN ──────────────────────────────────────────────────────────────────────
const dump = JSON.parse(fs.readFileSync(CFG.dump, 'utf8'));
const recs = dump.signals;
console.log('DAYDESK PORT-FIDELITY VERIFICATION');
console.log(`  dump: ${CFG.dump}  (${recs.length} body-ok minutes, window ${utc(dump.window.start)} -> ${utc(dump.window.end)})`);

const stats = {
  S7R6_2_d10: { bodyOk: 0, researchFired: 0, prodFired: 0, confirmed: 0, misses: [], extras: [], geoFails: [], maxRel: { risk: 0, target: 0, trail: 0, entry: 0 } },
  S1R7_2_360: { bodyOk: 0, researchFired: 0, prodFired: 0, confirmed: 0, misses: [], extras: [], geoFails: [], maxRel: { risk: 0, target: 0, trail: 0, entry: 0 } },
};
const unverifiable = new Map();

// group records by symbol, keep time order
const bySym = new Map();
for (const r of recs) {
  const sym = r[1];
  if (!bySym.has(sym)) bySym.set(sym, []);
  bySym.get(sym).push(r);
}
for (const arr of bySym.values()) arr.sort((a, b) => a[2] - b[2]);

// BTC data plane — loaded once, kept for every record's regime feeds
const btcRows = loadRows('BTC-USDT');
if (!btcRows) { console.error('BTC cache missing — cannot verify'); process.exit(1); }
const btc1hAll = fold(btcRows, 3600e3);
const btc1dAll = fold(btcRows, 86400e3);

const t0 = Date.now();
let done = 0;

for (const [sym, arr] of bySym) {
  const rows = sym === 'BTC-USDT' ? btcRows : loadRows(sym);
  if (!rows) { unverifiable.set(sym, arr.length); continue; }
  const b15 = fold(rows, 900e3);
  const b1h = sym === 'BTC-USDT' ? btc1hAll : fold(rows, 3600e3);

  for (const [vid, , t, bits, fired, stopDist, targetDist, trailDist, armR] of arr) {
    done++;
    const S = stats[vid];
    S.bodyOk++;
    if (fired) S.researchFired++;

    const now = t + 60000;
    const i1m = idxExact(rows.t, t);
    if (i1m < 0) { // minute missing from cache — cannot replay
      let u = unverifiable.get(`${sym}#gap`); if (!u) unverifiable.set(`${sym}#gap`, u = { n: 0 }); u.n++;
      continue;
    }
    const opts = {
      symbol: sym,
      now,
      price: rows.c[i1m],
      bars15: sliceBack(b15, idxLastComplete(b15, 900e3, now), 300),
      bars1h: sliceBack(b1h, idxLastComplete(b1h, 3600e3, now), 1000),
      btcBars1h: sliceBack(btc1hAll, idxLastComplete(btc1hAll, 3600e3, now), 1000),
      btcDaily: sliceBack(btc1dAll, idxLastComplete(btc1dAll, 86400e3, now), 30),
      bar1m: { time: t, open: rows.o[i1m], high: rows.h[i1m], low: rows.l[i1m], close: rows.c[i1m], volume: rows.v[i1m] },
    };

    let res;
    try {
      res = vid === 'S7R6_2_d10' ? evaluateDayBreakout(opts.bars15, opts) : evaluateDayCapitulation(opts.bars15, opts);
    } catch (err) {
      S.geoFails.push({ sym, t, utc: utc(t), why: `CRASH: ${err.message}` });
      continue;
    }
    const prodFired = res.state === 'DAY_EXECUTING' && res.tradeable === true;
    if (prodFired) S.prodFired++;

    if (fired && prodFired) {
      S.confirmed++;
      // ── geometry fidelity ──
      const su = res.setup;
      const rRisk = relErr(su.risk, stopDist);
      S.maxRel.risk = Math.max(S.maxRel.risk, rRisk);
      let bad = null;
      if (rRisk > 1e-5) bad = `risk ${su.risk} vs research ${stopDist} (rel ${rRisk.toExponential(2)})`;
      if (vid === 'S7R6_2_d10') {
        const rTgt = relErr(su.target - su.entry, targetDist);
        S.maxRel.target = Math.max(S.maxRel.target, rTgt);
        const rEntry = relErr(su.entry, rows.c[i1m] * 1.0002);
        S.maxRel.entry = Math.max(S.maxRel.entry, rEntry);
        if (!bad && rTgt > 1e-5) bad = `target-dist ${(su.target - su.entry).toFixed(8)} vs research ${targetDist} (rel ${rTgt.toExponential(2)})`;
        if (!bad && rEntry > 1e-6) bad = `entry ${su.entry} vs close×1.0002 ${rows.c[i1m] * 1.0002} (rel ${rEntry.toExponential(2)})`;
        if (!bad && su.trail?.mode !== 'NONE') bad = `trail mode ${su.trail?.mode} — expected NONE`;
      } else {
        const rTrail = relErr(su.trail.dist, trailDist);
        S.maxRel.trail = Math.max(S.maxRel.trail, rTrail);
        const rTgt = relErr(su.target - su.entry, 8 * su.risk); // nominal 8R live mirror
        S.maxRel.target = Math.max(S.maxRel.target, rTgt);
        if (!bad && rTrail > 1e-5) bad = `trail dist ${su.trail.dist} vs research ${trailDist} (rel ${rTrail.toExponential(2)})`;
        if (!bad && su.trail.armR !== 0.5) bad = `armR ${su.trail.armR} — expected 0.5`;
        if (!bad && su.trail.mode !== 'RATCHET') bad = `trail mode ${su.trail.mode} — expected RATCHET`;
        if (!bad && rTgt > 1e-5) bad = `nominal target ${su.target - su.entry} vs 8×risk ${8 * su.risk} (rel ${rTgt.toExponential(2)})`;
      }
      if (bad) S.geoFails.push({ sym, t, utc: utc(t), why: bad });
    } else if (fired && !prodFired) {
      let prodBits = null;
      try { prodBits = packBits(dayContextOf(opts.bars15, opts)); } catch { /* leave null */ }
      S.misses.push({
        sym, t, utc: utc(t), researchBits: bits, researchGates: bitNames(bits),
        prodBits, prodGates: prodBits != null ? bitNames(prodBits) : null,
        flipped: prodBits != null ? bitNames(bits ^ prodBits) : null,
        prodState: res.state, prodMissing: res.missing, narrative: (res.narrative || '').slice(0, 160),
      });
    } else if (!fired && prodFired) {
      let prodBits = null;
      try { prodBits = packBits(dayContextOf(opts.bars15, opts)); } catch { /* leave null */ }
      S.extras.push({
        sym, t, utc: utc(t), researchBits: bits, researchGates: bitNames(bits),
        prodBits, prodGates: prodBits != null ? bitNames(prodBits) : null,
        flipped: prodBits != null ? bitNames(bits ^ prodBits) : null,
        narrative: (res.narrative || '').slice(0, 160),
      });
    }
  }
  if ((done % 25000) < arr.length || done === recs.length) {
    process.stdout.write(`  ... ${done}/${recs.length} minutes replayed (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
}

// ── REVERSAL WALK — every minute on the busiest symbols, recent window ────────
const walk = { symbols: [], minutes: 0, outside: [], perDesk: { S7R6_2_d10: 0, S1R7_2_360: 0 } };
const recSet = new Map(); // `${vid}|${sym}` → Set(t) of logged body-ok minutes
for (const r of recs) {
  const k = `${r[0]}|${r[1]}`;
  if (!recSet.has(k)) recSet.set(k, new Set());
  recSet.get(k).add(r[2]);
}
const busiest = [...bySym.entries()].filter(([s]) => !unverifiable.has(s)).sort((a, b) => b[1].length - a[1].length).slice(0, CFG.walkCount);
const walkStart = dump.window.end - CFG.walkDays * 86400e3;

for (const [sym] of busiest) {
  const rows = sym === 'BTC-USDT' ? btcRows : loadRows(sym);
  if (!rows) continue;
  const b15 = fold(rows, 900e3);
  const b1h = sym === 'BTC-USDT' ? btc1hAll : fold(rows, 3600e3);
  walk.symbols.push(sym);
  for (let tt = Math.max(walkStart, rows.t[0]); tt <= dump.window.end - 60000; tt += 60000) {
    const i1m = idxExact(rows.t, tt);
    if (i1m < 0) continue;
    const now = tt + 60000;
    const opts = {
      symbol: sym, now, price: rows.c[i1m],
      bars15: sliceBack(b15, idxLastComplete(b15, 900e3, now), 300),
      bars1h: sliceBack(b1h, idxLastComplete(b1h, 3600e3, now), 1000),
      btcBars1h: sliceBack(btc1hAll, idxLastComplete(btc1hAll, 3600e3, now), 1000),
      btcDaily: sliceBack(btc1dAll, idxLastComplete(btc1dAll, 86400e3, now), 30),
      bar1m: { time: tt, open: rows.o[i1m], high: rows.h[i1m], low: rows.l[i1m], close: rows.c[i1m], volume: rows.v[i1m] },
    };
    walk.minutes++;
    for (const [vid, fn] of [['S7R6_2_d10', evaluateDayBreakout], ['S1R7_2_360', evaluateDayCapitulation]]) {
      let res;
      try { res = fn(opts.bars15, opts); } catch { continue; }
      if (res.state === 'DAY_EXECUTING' && res.tradeable) {
        const set = recSet.get(`${vid}|${sym}`);
        if (!set || !set.has(tt)) {
          walk.perDesk[vid]++;
          if (walk.outside.length < 20) walk.outside.push({ desk: vid, sym, t: tt, utc: utc(tt), narrative: (res.narrative || '').slice(0, 140) });
        }
      }
    }
  }
  process.stdout.write(`  walk ${sym}: done\n`);
}

// ── REPORT ────────────────────────────────────────────────────────────────────
console.log('\n== RESULTS ==');
let misses = 0, extras = 0, geo = 0;
for (const [vid, S] of Object.entries(stats)) {
  misses += S.misses.length; extras += S.extras.length; geo += S.geoFails.length;
  console.log(`  ${vid}:`);
  console.log(`    body-ok minutes ${S.bodyOk} · research fired ${S.researchFired} · daydesk fired ${S.prodFired}`);
  console.log(`    confirmed ${S.confirmed} · MISS ${S.misses.length} · EXTRA ${S.extras.length} · geometry fails ${S.geoFails.length}`);
  console.log(`    max rel err — risk ${S.maxRel.risk.toExponential(1)} · target ${S.maxRel.target.toExponential(1)} · trail ${S.maxRel.trail.toExponential(1)} · entry ${S.maxRel.entry.toExponential(1)}`);
}
const gaps = walk.perDesk.S7R6_2_d10 + walk.perDesk.S1R7_2_360;
console.log(`  reversal walk: ${walk.symbols.join(', ')} × ${CFG.walkDays}d (${walk.minutes} minutes) — fires outside body-ok set: ${gaps}`);
if (unverifiable.size) console.log(`  unverifiable: ${[...unverifiable.entries()].map(([s, n]) => `${s}(${typeof n === 'object' ? n.n : n})`).join(' ')}`);

const detail = (name, list, max) => {
  if (!list.length) return;
  console.log(`\n  ${name}:`);
  for (const m of list.slice(0, max)) {
    console.log(`    ${m.utc} ${m.sym} [research ${m.researchGates.join('+') || '—'}] -> [daydesk ${m.prodGates ? m.prodGates.join('+') || '—' : '?'}]${m.flipped ? ` flipped:${m.flipped.join(',')}` : ''}`);
    if (m.why) console.log(`      ${m.why}`);
    else if (m.prodMissing) console.log(`      daydesk parked: ${m.prodMissing}`);
  }
  if (list.length > max) console.log(`    ... ${list.length - max} more`);
};
for (const [vid, S] of Object.entries(stats)) {
  detail(`${vid} MISSES`, S.misses, CFG.maxDetail);
  detail(`${vid} EXTRAS`, S.extras, CFG.maxDetail);
  detail(`${vid} GEOMETRY FAILS`, S.geoFails, 10);
}
detail('WALK — fires outside the logged body-ok set', walk.outside, 20);

const totalFired = stats.S7R6_2_d10.researchFired + stats.S1R7_2_360.researchFired;
const mismatchRate = totalFired ? (misses + extras) / totalFired : 0;
const allFlippedExplained = [...stats.S7R6_2_d10.misses, ...stats.S1R7_2_360.misses, ...stats.S7R6_2_d10.extras, ...stats.S1R7_2_360.extras]
  .every(m => m.flipped && m.flipped.length > 0);
const verdict = (misses === 0 && extras === 0 && geo === 0 && gaps === 0) ? 'PASS'
  : (mismatchRate <= 0.005 && allFlippedExplained && geo === 0 && gaps === 0) ? 'CONDITIONAL (gate-boundary flips only)'
    : 'FAIL';
console.log(`\nPORT FIDELITY: ${verdict}  (research signals ${totalFired}, mismatch rate ${(mismatchRate * 100).toFixed(3)}%)`);

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const outFile = path.join(ROOT, 'backtest-reports', `verify-daydesk-${stamp}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  dump: CFG.dump, window: dump.window,
  verdict, mismatchRate,
  desks: Object.fromEntries(Object.entries(stats).map(([k, S]) => [k, {
    bodyOk: S.bodyOk, researchFired: S.researchFired, prodFired: S.prodFired,
    confirmed: S.confirmed, misses: S.misses.length, extras: S.extras.length, geometryFails: S.geoFails.length,
    maxRelErr: S.maxRel,
  }])),
  missDetails: [...stats.S7R6_2_d10.misses, ...stats.S1R7_2_360.misses],
  extraDetails: [...stats.S7R6_2_d10.extras, ...stats.S1R7_2_360.extras],
  geometryFails: [...stats.S7R6_2_d10.geoFails, ...stats.S1R7_2_360.geoFails],
  walk,
  unverifiable: [...unverifiable.entries()].map(([s, n]) => [s, typeof n === 'object' ? n.n : n]),
}, null, 2));
console.log(`Report saved: ${outFile}`);
