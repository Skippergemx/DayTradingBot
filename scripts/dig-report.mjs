#!/usr/bin/env node
// ── DIG REPORT ────────────────────────────────────────────────────────────────
// Pull monthly / exit-reason / symbol breakdowns for chosen variants out of a
// research JSON so iteration decisions are made on the failure anatomy, not on
// the headline number.
//
// Usage: node scripts/dig-report.mjs <report.json> [id1 id2 ...]
//        (no ids -> top 3 leaderboard rows)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [fileArg, ...ids] = process.argv.slice(2);
if (!fileArg) { console.error('usage: node scripts/dig-report.mjs <report.json|-> [ids...]'); process.exit(1); }
let file = fileArg;
if (file === '-') {
  const dir = path.resolve(__dirname, '..', 'backtest-reports');
  const newest = fs.readdirSync(dir)
    .filter(f => f.startsWith('research-') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!newest) { console.error('no research-*.json found'); process.exit(1); }
  file = path.join(dir, newest.f);
  console.log(`(digging newest report: ${newest.f})`);
}
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const want = ids.length ? ids : j.leaderboard.slice(0, 3).map(r => r.id);

const f$ = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);

for (const id of want) {
  const r = j.leaderboard.find(x => x.id === id);
  if (!r) { console.log(`\n!! ${id} not found`); continue; }
  console.log(`\n=== ${id} — ${r.label}`);
  for (const [k, s] of [['portfolio', r.portfolio], ['perSymbol', r.perSymbol]]) {
    if (!s) continue;
    console.log(`  [${k}] trades ${s.trades} WR ${s.winRate}% PF ${s.profitFactor} net ${f$(s.net)} H1 ${f$(s.h1)} H2 ${f$(s.h2)} DD ${f$(s.maxDD)}${s.maxConcurrent != null ? ` maxConc ${s.maxConcurrent}` : ''}`);
    const mo = Object.entries(s.monthly || {}).sort().map(([m, v]) => `${m.slice(5)} ${f$(v.net)}(${v.trades}t/${(v.wins / v.trades * 100).toFixed(0)}%)`).join('  ');
    console.log(`    months: ${mo}`);
    const br = Object.entries(s.byReason || {}).sort((a, b) => b[1].net - a[1].net).map(([rn, v]) => `${rn} ${f$(v.net)}(${v.trades}t/${(v.wins / v.trades * 100).toFixed(0)}%)`).join('  ');
    if (br) console.log(`    exits: ${br}`);
  }
  const syms = Object.entries(r.symbolBreakdown || {}).map(([sym, v]) => ({ sym, ...v })).sort((a, b) => b.net - a.net);
  if (syms.length) {
    console.log(`    best:  ${syms.slice(0, 6).map(x => `${x.sym.split('-')[0]}:${x.net.toFixed(0)}`).join(' ')}`);
    console.log(`    worst: ${syms.slice(-6).map(x => `${x.sym.split('-')[0]}:${x.net.toFixed(0)}`).join(' ')}`);
  }
}
