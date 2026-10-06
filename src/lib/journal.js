// ── MISSED-MOVER JOURNAL ──────────────────────────────────────────────────────
// The honest answer to "why didn't we take that move?". Every universe asset
// whose rolling 24h change crosses ±5% earns one record per UTC day, and the
// record carries the ACTIVE desk's exact verdict: taken by the book, held by a
// portfolio guard (direction gate / cap / breaker / fee floor / cooldown /
// correlation), ready but unfocused, or refused by the engine with its own
// `missing` line (regime, leash, volume, structure...). Day-desk refusals also
// carry the engine's full `gates` checklist (daydesk.js gateScan) so the ledger
// can show each asset's own story even while a desk-wide BTC gate stops all.
//
// Records are sticky-upgrade by design: verdicts only ever move UP the
// priority ladder (a taken trade is never erased by a later, tamer read), and
// the observed peak/trough survive the move fading back under the threshold —
// so a WLD-style spike stays on the ledger with the reason it wasn't chased.

import { utcDayKey } from './breaker';

export const MOVERS = {
  MIN_MOVE_PCT: 5,                        // |rolling 24h change| that flags an asset
  RETENTION_MS: 7 * 24 * 60 * 60 * 1000,  // a full week of flags
  MAX_ENTRIES: 240,                       // hard cap — the ledger never bloats
  STAMP_TTL_MS: 20 * 60 * 1000,           // guard stamps go stale after 20 minutes
  KEY: 'vortex_mover_journal',
};

// Verdict ranking — the record only ever upgrades. TAKEN cannot be lost.
const VERDICT_PRIORITY = {
  TAKEN: 5,
  HELD_GATE: 4, HELD_CAP: 4, HELD_BREAKER: 4, HELD_FEE: 4, HELD_COOLDOWN: 4, HELD_CORRELATED: 4,
  UNFOCUSED: 3, READY: 3,
  REFUSED: 2,
  NO_DATA: 1,
};

export const VERDICT_TEXT = {
  TAKEN: 'TAKEN',
  HELD_GATE: 'HELD · GATE',
  HELD_CAP: 'HELD · BOOK FULL',
  HELD_BREAKER: 'HELD · BREAKER',
  HELD_FEE: 'HELD · FEE FLOOR',
  HELD_COOLDOWN: 'HELD · COOLDOWN',
  HELD_CORRELATED: 'HELD · CORRELATED',
  UNFOCUSED: 'READY · UNFOCUSED',
  READY: 'READY',
  REFUSED: 'REFUSED',
  NO_DATA: 'NO DATA',
};

// Gate labels for the day-desk telemetry (src/lib/daydesk.js gateScan). `wide`
// marks the DESK-WIDE regime gates: when one of these is a row's first stop,
// every refusal shares the same string — so the ledger shows it once in the
// regime banner and gives each row its own asset-side story instead.
export const GATE_TEXT = {
  btcUp:   { label: 'BTC 1h uptrend', wide: true },
  btcD10:  { label: 'BTC daily > SMA10', wide: true },
  btcD10r: { label: 'BTC SMA10 rising', wide: true },
  h1:      { label: '1H trend ready' },
  h4ready: { label: '4H structure ready' },
  s4h:     { label: '4H close > rising EMA20' },
  t1h:     { label: '1H close > EMA100, EMA50 rising' },
  rsi2:    { label: '15m RSI(2) < 2' },
  atrFloor: { label: 'ATR/price ≥ 0.2%' },
  atrReady: { label: '15m ATR ready' },
  vol:     { label: 'bucket volume ≥ 1.5×' },
  nr7:     { label: 'NR7 compression' },
  bar1m:   { label: '1m tape ready' },
  above:   { label: '1m close > level' },
  leash:   { label: '≤ +0.4% past level' },
  strong:  { label: 'strong 1m close (≥60%)' },
};

/** Load + prune the persisted journal. Corrupt storage starts clean. */
export function loadJournal(now = Date.now()) {
  try {
    const raw = JSON.parse(localStorage.getItem(MOVERS.KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(r => r && r.id && r.symbol && now - (r.lastSeen || 0) <= MOVERS.RETENTION_MS)
      .slice(0, MOVERS.MAX_ENTRIES);
  } catch { return []; }
}

const tradeDetail = (t) => {
  if (t.status === 'PENDING') return `order resting — buy-limit $${t.entry}`;
  if (t.status === 'OPEN') return `in play @ $${t.entry}${t.pnl != null ? ` (${t.pnl}%)` : ''}`;
  const usd = parseFloat(t.usdPnl);
  const usdTxt = Number.isFinite(usd) ? ` (${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)})` : '';
  const flavor = t.status === 'WIN' ? 'target hit' : t.status === 'LOSS' ? 'stop hit' : t.status === 'ABANDONED' ? 'timed out' : 'never filled';
  return `${String(t.status).toLowerCase()} — ${flavor}${usdTxt}`;
};

const isToday = (ms, day) => Boolean(ms) && utcDayKey(ms) === day;

/** The desk's exact verdict for one flagged asset, in priority order. */
function classify({ sym, structures, trades, stamp, focused, day, now }) {
  // 1) The book owns it — an open position, a resting order, or a trade
  //    created/filled/closed inside this UTC day.
  const t = (trades || []).find(x => x.symbol === sym && (
    x.status === 'OPEN' || x.status === 'PENDING'
    || isToday(x.createdAt, day) || isToday(x.openedAt, day) || isToday(x.closedAt, day)
  ));
  if (t) return { verdict: 'TAKEN', detail: tradeDetail(t), state: null, missing: null, tradeStatus: t.status };

  // 2) A portfolio guard holds the focused desk — the most specific reason.
  if (stamp && stamp.symbol === sym && now - stamp.t <= MOVERS.STAMP_TTL_MS) {
    return { verdict: `HELD_${stamp.code}`, detail: stamp.detail, state: null, missing: null, tradeStatus: null };
  }

  // 3) The engine's own verdict for this asset.
  const b = structures?.[sym];
  if (!b) return { verdict: 'NO_DATA', detail: 'planes still warming — no structure read for this asset yet', state: null, missing: null, tradeStatus: null };
  const executing = b.state === 'EXECUTING' || b.state === 'DAY_EXECUTING';
  if (executing) {
    return {
      verdict: focused === sym ? 'READY' : 'UNFOCUSED',
      detail: focused === sym
        ? `engine at [${b.state}] — handoff to the book in flight`
        : `engine reached [${b.state}] while the desk hunted elsewhere`,
      state: b.state, missing: null, tradeStatus: null,
    };
  }
  return { verdict: 'REFUSED', detail: b.missing || `parked at [${b.state}]`, state: b.state, missing: b.missing || null, tradeStatus: null, gates: Array.isArray(b.gates) ? b.gates : null };
}

/**
 * One collection pass — merges the current board/trade/guard state into the
 * journal. Cheap by construction (only |change| ≥ MIN_MOVE_PCT assets are
 * touched), so a 10s cadence is free. A record stops updating once its move
 * fades back under the threshold; its extremes and verdict are frozen as the
 * honest "what we observed" of that day.
 *
 * Returns { next, changed, fresh }: `next` is the new array, `changed` is true
 * when anything worth re-rendering moved, `fresh` lists brand-new records for
 * one-time narration.
 */
export function collectMovers({ prev, marketData, structures, trades, stamp, desk, focused, now }) {
  const day = utcDayKey(now);
  const map = new Map((prev || []).map(r => [r.id, r]));
  const fresh = [];
  let changed = false;

  for (const m of marketData || []) {
    const chg = Number(m?.change);
    if (!Number.isFinite(chg) || Math.abs(chg) < MOVERS.MIN_MOVE_PCT) continue;
    const sym = m.symbol;
    const id = `${day}:${sym}`;
    const before = map.get(id) || null;
    const snap = classify({ sym, structures, trades, stamp, focused, day, now });

    const rec = before ? { ...before } : {
      id, day, symbol: sym, firstSeen: now,
      peak: chg, trough: chg, verdict: null, gates: null,
    };
    rec.lastSeen = now;
    rec.change = chg;
    rec.peak = Math.max(rec.peak ?? chg, chg);
    rec.trough = Math.min(rec.trough ?? chg, chg);
    rec.price = m.price;
    rec.focused = focused === sym;
    rec.desk = desk;

    if ((VERDICT_PRIORITY[snap.verdict] ?? 0) >= (VERDICT_PRIORITY[rec.verdict] ?? 0)) {
      rec.verdict = snap.verdict;
      rec.detail = snap.detail;
      rec.state = snap.state;
      rec.missing = snap.missing;
      rec.tradeStatus = snap.tradeStatus;
      rec.gates = snap.gates ?? null;
    }

    const isNew = !before;
    const upgraded = !isNew && (
      before.verdict !== rec.verdict || before.detail !== rec.detail
      || before.state !== rec.state || before.tradeStatus !== rec.tradeStatus
      || JSON.stringify(before.gates ?? null) !== JSON.stringify(rec.gates ?? null)
    );
    const moved = !isNew && (
      Math.abs((before.change ?? chg) - chg) >= 0.01
      || rec.peak !== before.peak || rec.trough !== before.trough
      || before.focused !== rec.focused || before.desk !== rec.desk
    );
    if (isNew || upgraded || moved) changed = true;
    if (isNew) fresh.push(rec);
    map.set(id, rec);
  }

  // Retention prune + hard cap — still-movers keep a full week, then expire.
  let next = [...map.values()].filter(r => now - (r.lastSeen || 0) <= MOVERS.RETENTION_MS);
  if (next.length !== map.size) changed = true;
  next.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  if (next.length > MOVERS.MAX_ENTRIES) { next = next.slice(0, MOVERS.MAX_ENTRIES); changed = true; }

  return { next, changed, fresh };
}
