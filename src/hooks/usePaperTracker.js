import { useState, useEffect, useRef } from 'react';
import { applyOutcomes } from '../lib/vio8';
import { SIZING, computePositionSize, closeLegNet, remainingNotional, boundedStopFill } from '../lib/sizing';

const FINAL_STATUSES = new Set(['WIN', 'LOSS', 'ABANDONED', 'EXPIRED']);

// The desk lineup after the 2026-10 multi-day removal. A persisted trade still
// OPEN/PENDING under any other tag — AGGRESSIVE_SWING, IGNITION, or a pre-meta
// record with no strategy at all — is a legacy hold and must never trade again.
const CURRENT_DESKS = new Set(['ICT_PRECISION', 'DAY_BREAKOUT', 'DAY_CAPITULATION']);

/**
 * One-time load-path settlement for the removed multi-day desks. An OPEN hold
 * closes at its last recorded price (entry as the floor) and its realized net
 * lands in the ledger; a PENDING order never filled, so it just expires. Both
 * stay in history flagged `legacy`. Idempotent — settled rows no longer match,
 * so later loads derive delta 0.
 */
const settleLegacyHolds = (list) => {
  let balanceDelta = 0;
  const out = list.map((t) => {
    if (t.status !== 'OPEN' && t.status !== 'PENDING') return t;
    if (CURRENT_DESKS.has(t.strategy)) return t;
    const legacyDesk = t.strategy || 'pre-meta';
    if (t.status === 'PENDING') {
      return { ...t, status: 'EXPIRED', legacy: true, legacyDesk, closedAt: Date.now() };
    }
    const price = Number(t.currentPrice) || Number(t.entry) || 0;
    if (!(t.entry > 0) || !(price > 0)) {
      // Degenerate pre-meta rows (missing geometry) retire without money math.
      return { ...t, status: 'ABANDONED', legacy: true, legacyDesk, closedAt: Date.now() };
    }
    const size = t.size ?? SIZING.MAX_NOTIONAL;
    const pnlPct = ((price - t.entry) / t.entry) * 100;
    const netPnl = closeLegNet({ remaining: size, pnlPct, entryFee: t.entryFee ?? size * SIZING.FEE_RATE });
    balanceDelta += netPnl;
    return {
      ...t, status: 'ABANDONED', legacy: true, legacyDesk,
      exitPrice: price, pnl: pnlPct.toFixed(2), closedAt: Date.now(), usdPnl: netPnl.toFixed(2),
    };
  });
  return { trades: out, balanceDelta };
};

/**
 * usePaperTracker - Simulates trades based on Vio8's advice and tracks performance.
 */
export const usePaperTracker = (marketData) => {
  const [trades, setTrades] = useState(() => {
    const saved = localStorage.getItem('vortex_paper_trades');
    if (!saved) return [];
    try {
      // Load-path migration: settle leftover multi-day holds before the app
      // can ever render them as live positions (idempotent by construction).
      return settleLegacyHolds(JSON.parse(saved)).trades;
    } catch { return []; } // corrupt storage — start clean
  });

  const [balance, setBalance] = useState(() => {
    const saved = localStorage.getItem('vortex_paper_balance');
    const repaired = localStorage.getItem('vortex_balance_v2') === '1';
    // The load-path settlement above moves real money: the ledger carries the
    // same delta, and the v2 rebuild below scores the settled rows because
    // their usdPnl is already stamped.
    let raw = [];
    try { raw = JSON.parse(localStorage.getItem('vortex_paper_trades') || '[]'); } catch { /* corrupt storage */ }
    const { trades: migrated, balanceDelta } = settleLegacyHolds(raw);
    if (saved && repaired) return parseFloat(saved) + balanceDelta;
    // One-time ledger repair (v2): the pre-fix balance credited the full
    // position notional on every close without ever debiting it at fill, so
    // stored balances ballooned by ~$1k per closed trade. Rebuild equity as
    // $10k + the sum of every closed trade's realized net.
    let equity = 10000.0;
    for (const t of migrated) {
      if (FINAL_STATUSES.has(t.status)) {
        const n = parseFloat(t.usdPnl);
        if (Number.isFinite(n)) equity += n;
      }
    }
    return Math.round(equity * 100) / 100; // default $10k capital when there is nothing to rebuild from
  });

  const [streak, setStreak] = useState(() => {
    const saved = localStorage.getItem('vortex_paper_streak');
    return saved ? parseInt(saved) : 0;
  });

  const [maxStreak, setMaxStreak] = useState(() => {
    const saved = localStorage.getItem('vortex_paper_max_streak');
    return saved ? parseInt(saved) : 0;
  });

  const tradesRef = useRef(trades);
  useEffect(() => {
    tradesRef.current = trades;
    localStorage.setItem('vortex_paper_trades', JSON.stringify(trades));
    localStorage.setItem('vortex_paper_balance', balance.toString());
    localStorage.setItem('vortex_paper_streak', streak.toString());
    localStorage.setItem('vortex_paper_max_streak', maxStreak.toString());
    localStorage.setItem('vortex_balance_v2', '1'); // ledger repair marker
  }, [trades, balance, streak, maxStreak]);

  // Track prices to close trades
  useEffect(() => {
    if (!marketData || marketData.length === 0) return;

    let balanceDelta = 0;
    let changed = false;
    let newStreak = streak;
    const ledgerOutcomes = []; // verdict-ledger write-backs collected during this pass

    const updatedTrades = tradesRef.current.map(trade => {
      const currentAsset = marketData.find(m => m.symbol === trade.symbol);
      if (!currentAsset) return trade;

      const price = parseFloat(currentAsset.price);
      
      // Bad-tick guard: a non-finite or non-positive print is a feed glitch, not
      // a price — never let one snapshot fill an order or settle a position.
      if (!Number.isFinite(price) || price <= 0) return trade;

      // --- LOGIC FOR PENDING TRADES ---
      if (trade.status === 'PENDING') {
        // ... (existing pending logic)
        const expireMs = trade.expireMs ?? 2 * 60 * 60 * 1000; // day desks ship a 5-minute leash via meta; 2h is the precision default
        if (Date.now() - (trade.createdAt || trade.openedAt) > expireMs) {
          changed = true;
          if (trade.verdictId) ledgerOutcomes.push({ id: trade.verdictId, outcome: { status: 'EXPIRED', note: 'entry never touched', holdMin: Math.round((Date.now() - (trade.createdAt || trade.openedAt)) / 60000), closedAt: Date.now() } });
          return { ...trade, status: 'EXPIRED', closedAt: Date.now() };
        }
        if (price <= trade.entry) {
          changed = true;
          const entryFee = (trade.size ?? SIZING.MAX_NOTIONAL) * SIZING.FEE_RATE; 
          return { ...trade, status: 'OPEN', openedAt: Date.now(), entryFee };
        }
        return trade;
      }

      if (trade.status !== 'OPEN') return trade;

      // --- LOGIC FOR OPEN TRADES ---
      const size = trade.size ?? SIZING.MAX_NOTIONAL;
      const pnl = ((price - trade.entry) / trade.entry) * 100;
      // Origin risk is frozen at arming time — trail/breakeven moves must never
      // shrink the yardstick the trail triggers measure against.
      const risk0 = trade.risk0 ?? (trade.entry - trade.stopLoss);
      let stopLoss = trade.stopLoss;
      let peak = trade.peak ?? trade.entry;

      if (trade.trail?.mode === 'NONE') {
        // ── DAY BREAKOUT (NR7) — static stop, by design ──
        // The validated exit shape is stop / 4R limit / 12h time only; every
        // trail variant tested in the research lab degraded it (PF 0.89), so
        // the stop never moves. Nothing to ratchet here.
      } else if (trade.trail?.mode === 'RATCHET') {
        // ── DAY CAPITULATION (RSI2) — pure peak ratchet ──
        // Mirrors the research simulator's manageBar exactly: once the PEAK
        // arms at +armR×risk the stop trails at peak − dist, tightening only.
        // Deliberately NO forced-breakeven jump — that was not what the day
        // desk was validated on.
        peak = Math.max(peak, price);
        if (risk0 > 0 && peak >= trade.entry + (trade.trail.armR ?? 0.5) * risk0) {
          const trailed = peak - trade.trail.dist;
          if (trailed > stopLoss) { changed = true; stopLoss = trailed; }
        }
      } else {
        // ── Fixed-scale ratchet (precision desk) ──
        if (pnl >= 1.0 && stopLoss < trade.entry) { changed = true; stopLoss = trade.entry; }
        if (pnl >= 2.0 && stopLoss < trade.entry * 1.01) { changed = true; stopLoss = trade.entry * 1.01; }
      }

      const updatedTrade = { ...trade, currentPrice: price, pnl: pnl.toFixed(2), stopLoss, peak };

      const maxHoldMs = trade.maxHoldMs ?? 6 * 60 * 60 * 1000; // precision default; day desks ship their validated windows
      if (Date.now() - (trade.openedAt || trade.createdAt) > maxHoldMs) {
        changed = true;
        const netPnl = closeLegNet({ remaining: size, pnlPct: pnl, entryFee: trade.entryFee ?? size * SIZING.FEE_RATE });
        balanceDelta += netPnl;
        if (trade.verdictId) ledgerOutcomes.push({ id: trade.verdictId, outcome: { status: 'ABANDONED', usdPnl: netPnl.toFixed(2), exitPrice: price, holdMin: Math.round((Date.now() - (trade.openedAt || trade.createdAt)) / 60000), closedAt: Date.now() } });
        return { ...updatedTrade, status: 'ABANDONED', exitPrice: price, closedAt: Date.now(), usdPnl: netPnl.toFixed(2) };
      }

      // Check Target (WIN) — a resting limit fills AT the target, not at
      // wherever the next poll finds price.
      if (price >= trade.target) {
        changed = true;
        newStreak += 1;
        const winPct = ((trade.target - trade.entry) / trade.entry) * 100;
        const netProfit = closeLegNet({ remaining: size, pnlPct: winPct, entryFee: trade.entryFee ?? size * SIZING.FEE_RATE });
        balanceDelta += netProfit;
        if (trade.verdictId) ledgerOutcomes.push({ id: trade.verdictId, outcome: { status: 'WIN', usdPnl: netProfit.toFixed(2), exitPrice: trade.target, holdMin: Math.round((Date.now() - (trade.openedAt || trade.createdAt)) / 60000), closedAt: Date.now() } });
        return { ...updatedTrade, status: 'WIN', exitPrice: trade.target, pnl: winPct.toFixed(2), closedAt: Date.now(), usdPnl: netProfit.toFixed(2) };
      }

      // Check Stop Loss (LOSS)
      if (price <= trade.stopLoss) {
        changed = true;
        // A stop is a market exit at the stop level; a real gap-through is
        // honored only up to STOP_GAP_MULT × the origin risk. Settling at the
        // raw print let a thin wick or bad tick book the whole notional.
        const fillPrice = boundedStopFill({ entry: trade.entry, stopLoss, price, risk0 });
        const lossPct = ((fillPrice - trade.entry) / trade.entry) * 100;
        const netLoss = closeLegNet({ remaining: size, pnlPct: lossPct, entryFee: trade.entryFee ?? size * SIZING.FEE_RATE });
        newStreak = 0; // a stopped trade always resets the streak
        balanceDelta += netLoss;
        if (trade.verdictId) ledgerOutcomes.push({ id: trade.verdictId, outcome: { status: 'LOSS', usdPnl: netLoss.toFixed(2), exitPrice: fillPrice, holdMin: Math.round((Date.now() - (trade.openedAt || trade.createdAt)) / 60000), closedAt: Date.now() } });
        return { ...updatedTrade, status: 'LOSS', exitPrice: fillPrice, pnl: lossPct.toFixed(2), closedAt: Date.now(), usdPnl: netLoss.toFixed(2) };
      }

      return updatedTrade;
    });

    if (changed) {
      setTrades(updatedTrades);
      setBalance(prev => prev + balanceDelta);
      setStreak(newStreak);
      if (newStreak > maxStreak) setMaxStreak(newStreak);
    }
    if (ledgerOutcomes.length) applyOutcomes(ledgerOutcomes);
  }, [marketData]);

  // ... (rest of the hook stays the same)
  const addTrade = (symbol, entry, stop, target, verdictId = null, meta = {}) => {
    const existing = tradesRef.current.find(t => t.symbol === symbol && (t.status === 'OPEN' || t.status === 'PENDING'));
    if (existing) return null;
    const activeCapital = tradesRef.current
      .filter(t => t.status === 'OPEN' || t.status === 'PENDING')
      .reduce((acc, t) => acc + remainingNotional(t), 0);
    if (balance - activeCapital < SIZING.MIN_NOTIONAL) return; // coarse gate — the sized check follows
    const liveAsset = marketData.find(m => m.symbol === symbol);
    if (!liveAsset) return;
    // Number-first parsing: exponential-notation strings ("9e-7" for sub-1e-6
    // prices) are mangled by the character filter ("97") — only strip
    // formatting noise when the value is not already numeric.
    const cleanNum = (v) => {
      const direct = typeof v === 'number' ? v : Number(String(v).trim());
      if (Number.isFinite(direct)) return direct;
      return parseFloat(String(v).replace(/[^0-9.]/g, ''));
    };
    const entryPrice = cleanNum(entry);
    const stopPrice = cleanNum(stop);
    const targetPrice = cleanNum(target);
    if (![entryPrice, stopPrice, targetPrice].every(Number.isFinite) || entryPrice <= 0) return;
    if (targetPrice <= entryPrice || stopPrice >= entryPrice) {
      console.warn(`VORTEX > Signal rejected: invalid geometry for ${symbol} (entry ${entryPrice}, stop ${stopPrice}, target ${targetPrice})`);
      return;
    }
    const plan = computePositionSize({ entry: entryPrice, stop: stopPrice });
    if (!plan) return null;
    if (balance - activeCapital < plan.size) return null; // size-aware free-capital check
    const newTrade = {
      id: Math.random().toString(36).substr(2, 9), symbol, entry: entryPrice, stopLoss: stopPrice, target: targetPrice, verdictId,
      status: 'PENDING', createdAt: Date.now(),
      // Risk-parity size + frozen origin risk (trail moves must never shrink
      // the yardstick the trail triggers measure against).
      size: plan.size, risk: plan.risk, risk0: entryPrice - stopPrice,
      // Desk metadata: the day desks ship a trail plan and time windows;
      // precision keeps the defaults.
      strategy: meta.strategy || null,
      trail: meta.trail || null,
      expireMs: meta.expireMs ?? null,
      maxHoldMs: meta.maxHoldMs ?? null,
    };
    setTrades(prev => [newTrade, ...prev].slice(0, 50));
    return newTrade;
  };

  const stats = {
    total: trades.filter(t => t.status !== 'OPEN' && t.status !== 'PENDING').length,
    wins: trades.filter(t => t.status === 'WIN').length,
    losses: trades.filter(t => t.status === 'LOSS').length,
    winRate: 0,
    streak,
    maxStreak
  };
  
  if (stats.total > 0) stats.winRate = Math.round((stats.wins / stats.total) * 100);

  const resetTrades = () => {
    setTrades([]); setBalance(10000.00); setStreak(0); setMaxStreak(0);
    localStorage.removeItem('vortex_paper_trades');
    localStorage.removeItem('vortex_paper_balance');
    localStorage.removeItem('vortex_paper_streak');
    localStorage.removeItem('vortex_paper_max_streak');
    localStorage.removeItem('vortex_balance_v2');
  };

  return { trades, addTrade, resetTrades, stats, balance };
};
