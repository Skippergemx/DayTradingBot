#!/usr/bin/env node
// ── REGIME SCAN ───────────────────────────────────────────────────────────────
// Reads the shared 1m cache and prints what the market was doing — the exact
// regime flags the strategy families consume (BTC 1h trend gate, kingdom
// threat gate) — so gate design is evidence-based instead of curve-fit.
//
// Usage: node scripts/regime-scan.mjs [--days 130]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.backtest-cache');

const args = process.argv.slice(2);
let days = 130;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days') days = Number(args[++i]);
}

const load = (pair) => JSON.parse(fs.readFileSync(path.join(CACHE, `1m_${pair}.json`), 'utf8'));

function ema(vals, p) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < p) return out;
  let e = 0;
  for (let i = 0; i < p; i++) e += vals[i];
  e /= p; out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function fold(rows, ms) {
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let cur = -1;
  for (const r of rows) {
    const b = Math.floor(r[0] / ms) * ms;
    if (b !== cur) { cur = b; t.push(b); o.push(r[1]); h.push(r[2]); l.push(r[3]); c.push(r[4]); v.push(r[5]); }
    else { const j = h.length - 1; if (r[2] > h[j]) h[j] = r[2]; if (r[3] < l[j]) l[j] = r[3]; c[j] = r[4]; v[j] += r[5]; }
  }
  return { t, o, h, l, c, v };
}

const NOW = Date.now();
const START = NOW - days * 86400e3;

const btc = load('BTCUSDT');
const eth = load('ETHUSDT');

const h1 = fold(btc, 3600e3);
const e100 = ema(h1.c, 100);
const e50 = ema(h1.c, 50);
const up1h = new Array(h1.t.length).fill(0);
for (let i = 0; i < h1.t.length; i++) {
  if (e100[i] != null && e50[i] != null && e50[i - 1] != null && e50[i - 1] > 0) {
    const slopeUp = e50[i] / e50[i - 1] - 1 > 0;
    up1h[i] = h1.c[i] > e100[i] && slopeUp ? 1 : 0;
  }
}
const idxByHour = new Map(h1.t.map((t, i) => [t, i]));
const btcByMin = new Map(btc.map((r, i) => [r[0], i]));
const ethByMin = new Map(eth.map((r, i) => [r[0], i]));

function chg24h(rows, byMin, t) {
  const i = byMin.get(t);
  if (i == null || i < 1440 || !(rows[i - 1440][4] > 0)) return NaN;
  return (rows[i][4] / rows[i - 1440][4] - 1) * 100;
}

// daily aggregation
const dayMs = 86400e3;
const firstDay = Math.floor(START / dayMs) * dayMs;
console.log(`REGIME SCAN  (${new Date(START).toISOString().slice(0, 10)} -> ${new Date(NOW).toISOString().slice(0, 10)})`);
console.log('date        close   d24h%   up1h   threat   closeVsE20d');
console.log('----------  ------  ------  -----  ------  -----------');

const dayClose = [];
for (let d = firstDay; d < NOW; d += dayMs) {
  let upCount = 0, hourCount = 0, threatCount = 0, minCount = 0, last = null;
  for (let t = d; t < d + dayMs && t < NOW; t += 3600e3) {
    const i = idxByHour.get(t);
    if (i == null) continue;
    hourCount++;
    if (up1h[i]) upCount++;
  }
  for (let t = d; t < d + dayMs && t < NOW; t += 60000) {
    if (!btcByMin.has(t)) continue;
    minCount++;
    const bc = chg24h(btc, btcByMin, t);
    const ec = chg24h(eth, ethByMin, t);
    if (bc < -3 || ec < -5 || bc < -1.5 || ec < -2) threatCount++;
  }
  const b0 = btcByMin.get(d);
  if (b0 == null) continue;
  last = btc[b0 + Math.min(1439, btc.length - 1 - b0)]?.[4] ?? null;
  // day close = last minute close within the day
  let close = null;
  for (let t = d; t < d + dayMs && t < NOW; t += 60000) { const i = btcByMin.get(t); if (i != null) close = btc[i][4]; }
  if (close == null) continue;
  const prevIdx = btcByMin.get(d - dayMs);
  const d24 = prevIdx != null && btc[prevIdx][4] > 0 ? (() => {
    let prevClose = null;
    for (let t = d - dayMs; t < d; t += 60000) { const i = btcByMin.get(t); if (i != null) prevClose = btc[i][4]; }
    return prevClose ? (close / prevClose - 1) * 100 : NaN;
  })() : NaN;
  dayClose.push(close);
  const e20d = dayClose.length >= 20 ? dayClose.slice(-20).reduce((a, x) => a + x, 0) / 20 : NaN;
  const vs = Number.isFinite(e20d) ? ((close / e20d - 1) * 100).toFixed(1) + '%' : '   -';
  const upF = hourCount ? (upCount / hourCount * 100).toFixed(0) + '%' : '  -';
  const thF = minCount ? (threatCount / minCount * 100).toFixed(0) + '%' : '  -';
  console.log(`${new Date(d).toISOString().slice(0, 10)}  ${close.toFixed(0).padStart(6)}  ${(Number.isFinite(d24) ? d24.toFixed(1) : '  -').padStart(6)}  ${upF.padStart(5)}  ${thF.padStart(6)}  ${vs.padStart(10)}`);
}

// monthly summary of the up1h flag
console.log('\nMonthly regime summary (share of hours with BTC 1h uptrend gate TRUE):');
const byMonth = {};
for (let i = 0; i < h1.t.length; i++) {
  if (h1.t[i] < START) continue;
  const k = new Date(h1.t[i]).toISOString().slice(0, 7);
  const m = byMonth[k] = byMonth[k] || { up: 0, n: 0 };
  m.n++; m.up += up1h[i];
}
for (const [k, m] of Object.entries(byMonth).sort()) {
  console.log(`  ${k}: up1h ${(m.up / m.n * 100).toFixed(1)}% of ${m.n} hours`);
}

// champion-signal frequency per regime — count raw NR7 & RSI2<3 signals per day
// is done in the lab; here we only characterize the tape.
