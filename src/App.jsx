import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useMarketFeed } from './hooks/useMarketFeed';
import { usePaperTracker } from './hooks/usePaperTracker';
import { ChartTab } from './components/ChartTab';
import { DeskTab } from './components/DeskTab';
import { IntelTab } from './components/IntelTab';
import { MoversTab } from './components/MoversTab';
import { TradeModal } from './components/TradeModal';
import { useVio8Advisor } from './hooks/useVio8Advisor';
import { CommandBar } from './components/CommandBar';
import { cn } from './lib/utils';
import { computeKingdomThreat } from './lib/engine';
import { validateVio8Signal, appendVerdict, MAX_CONCURRENT_POSITIONS } from './lib/vio8';
import { AUTOPILOT, scoreFocusCandidates, isWorkable } from './lib/autopilot';
import { evaluateICT, fmtPrice } from './lib/ict';
import { evaluateDayBreakout, evaluateDayCapitulation, DAYDESK } from './lib/daydesk';
import { remainingNotional } from './lib/sizing';
import { RISK, correlatedWith, lastLosingSettle } from './lib/risk';
import { breakerVerdict } from './lib/breaker';
import { ensureWindow, computeScoreboard } from './lib/scoreboard';
import { MOVERS, loadJournal, collectMovers, VERDICT_TEXT } from './lib/journal';

const FINAL_TRADE_STATUSES = new Set(['WIN', 'LOSS', 'ABANDONED', 'EXPIRED']);

// Hybrid tone: the engine's threat enum stays untouched — CommandBar maps it to pro labels.

function App() {
  const { 
    marketData, status, candleSource, priceSource,
    selectedSymbol, setSelectedSymbol,
    candles, candleBook, dayBook, day1hBook, btcDaily, news, fundamentals, fearGreed, hourlyTrend, globalStats, trending, diagnostics
  } = useMarketFeed();
  
  const { trades, addTrade, resetTrades, stats, balance } = usePaperTracker(marketData);
  
  // --- KINGDOM THREAT CALCULATION ---
  const btc = marketData.find(m => m.symbol === 'BTC-USDT');
  const eth = marketData.find(m => m.symbol === 'ETH-USDT');
  const kingdomThreat = useMemo(
    () => computeKingdomThreat(parseFloat(btc?.change), parseFloat(eth?.change)),
    [btc, eth]
  );

  // ── DESK STATE MACHINES — deterministic structure telemetry ────────────────
  // Pure JSON out of lib/ict.js (ICT_PRECISION — the 1H Silver Bullet) and
  // lib/daydesk.js (the two frozen intraday desks — 15m NR7 breakout, 15m
  // RSI(2) capitulation). The UI and the execution loop only read the active
  // strategy's board, so the dashboard renders instantly and can never block
  // the evaluation loop. One 30s clock keeps killzone/bucket semantics fresh
  // even while candles are static.
  const [strategy, setStrategy] = useState(() => {
    const saved = localStorage.getItem('vortex_strategy');
    return saved === 'DAY_BREAKOUT' || saved === 'DAY_CAPITULATION' ? saved : 'ICT_PRECISION';
  });
  const isDayBreakout = strategy === 'DAY_BREAKOUT';
  const isDayCapitulation = strategy === 'DAY_CAPITULATION';
  const isDay = isDayBreakout || isDayCapitulation; // the two validated intraday desks
  // Round-12 BTC trend-gate switch — persisted, default ON (the shipped ruling).
  // OFF bypasses the two trend reads (BTC 1h uptrend + daily SMA10 rising) in
  // the day desks; BTC > daily SMA10 and every asset gate still stand
  // (evidence: backtest-reports/lab12-gate-ablation-report.md).
  const [btcTrendGate, setBtcTrendGate] = useState(() => localStorage.getItem('vortex_btc_trend_gate') !== '0');
  useEffect(() => { localStorage.setItem('vortex_btc_trend_gate', btcTrendGate ? '1' : '0'); }, [btcTrendGate]);
  const [ictClock, setIctClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setIctClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // ── CAPITAL GUARDS (lib/breaker.js · lib/scoreboard.js) — week-1 discipline ──
  // The daily breaker reads realized closes against the UTC day's starting
  // equity; the scoreboard scores the trailing 7d against a BTC buy-and-hold.
  // Both persist their anchors, so a reload cannot reset the count or
  // cherry-pick a flattering window.
  const breaker = useMemo(() => breakerVerdict(trades, balance, ictClock), [trades, balance, ictClock]);
  const btcPriceNow = useMemo(() => {
    const p = parseFloat(marketData.find(m => m.symbol === 'BTC-USDT')?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  }, [marketData]);
  const [sbAnchor, setSbAnchor] = useState(null);
  useEffect(() => {
    const a = ensureWindow(Date.now(), balance, btcPriceNow);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time persisted anchor seed once the feed has a BTC mark
    if (a) setSbAnchor(a);
  }, [balance, btcPriceNow]);
  const scoreboard = useMemo(
    () => computeScoreboard({ trades, balance, btcDaily, btcPriceNow, anchor: sbAnchor, now: ictClock }),
    [trades, balance, btcDaily, btcPriceNow, sbAnchor, ictClock]
  );
  // Live scan prices feed the day desks' checks (they fall back to the bar close).
  const priceMap = useMemo(() => {
    const map = {};
    for (const m of marketData) {
      const p = parseFloat(m.price);
      if (Number.isFinite(p) && p > 0) map[m.symbol] = p;
    }
    return map;
  }, [marketData]);
  const structureBoard = useMemo(() => {
    const board = {};
    if (isDay) {
      // Day desks: 15m compression off dayBook, 1H trend + 4H structure off the
      // converged 1000-bar 1H day plane (research-identical EMA100/50 + 4H EMA20),
      // daily regime off btcDaily, and the last COMPLETED 1m bar as the signal-bar
      // check (the newest book bar is still forming — research lastDone discipline).
      const evaluate = isDayBreakout ? evaluateDayBreakout : evaluateDayCapitulation;
      const btcBars1h = day1hBook['BTC-USDT'] || null;
      for (const [sym, bars] of Object.entries(dayBook)) {
        if (!Array.isArray(bars) || !bars.length) continue;
        const book1m = candleBook[sym];
        const last1m = Array.isArray(book1m) && book1m.length ? book1m[book1m.length - 1] : null;
        const bar1m = last1m && last1m.time + 60000 <= ictClock ? last1m
          : (Array.isArray(book1m) && book1m.length > 1 ? book1m[book1m.length - 2] : null);
        board[sym] = evaluate(bars, {
          symbol: sym, now: ictClock, price: priceMap[sym] || null,
          bars1h: day1hBook[sym] || null, btcBars1h, btcDaily, bar1m, btcTrendGate,
        });
      }
    } else {
      for (const [sym, bars] of Object.entries(candleBook)) {
        if (Array.isArray(bars) && bars.length) board[sym] = evaluateICT(bars, { symbol: sym, now: ictClock });
      }
    }
    return board;
  }, [isDay, isDayBreakout, candleBook, dayBook, day1hBook, btcDaily, ictClock, priceMap, btcTrendGate]);
  const selectedStructure = structureBoard[selectedSymbol] || null;

  // Desk-wide regime read for the mover banner — any warm day-desk read carries
  // the same BTC gates (regime: btcUp / btcD10 / btcD10r).
  const deskRegime = useMemo(() => {
    if (!isDay) return null;
    for (const b of Object.values(structureBoard)) if (b && b.regime) return b.regime;
    return null;
  }, [isDay, structureBoard]);

  const availableBalance = useMemo(() => {
    const activeCapital = trades
      .filter(t => t.status === 'OPEN' || t.status === 'PENDING')
      .reduce((acc, t) => acc + remainingNotional(t), 0);
    return balance - activeCapital;
  }, [trades, balance]);
  
  const { advice, isAnalyzing, adviceMeta } = useVio8Advisor(marketData, news, fundamentals, fearGreed, selectedSymbol, hourlyTrend, trades, balance, kingdomThreat, candles, selectedStructure, strategy);
  const [showDevMode, setShowDevMode] = useState(false);
  const [activeCategory, setActiveCategory] = useState('ALL');
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [activeTab, setActiveTab] = useState('CHART'); // 'CHART' | 'DESK' | 'INTEL' | 'MOVERS'

  // ── VIO8 AUTOPILOT — she hunts for her own desk; a manual click overrides ──
  const [autopilotOn, setAutopilotOn] = useState(() => localStorage.getItem('vortex_autopilot') === '1');
  const [autopilotNotice, setAutopilotNotice] = useState(null);
  const manualHoldRef = useRef(0);
  const lastAutoSwitchRef = useRef(0);
  const marketDataRef = useRef([]);
  const tradesTrackRef = useRef([]);
  const selectedSymbolRef = useRef('BTC-USDT');
  const structureBoardRef = useRef({});
  const lastIctKeyRef = useRef(new Map());    // symbol → last narrated `${state}|${missing}`
  const lastExecutedStructRef = useRef(null); // structure id of the last armed/held setup (any desk)
  const llmHoldMetaRef = useRef(null);        // dedupe for "LLM wanted execute, machine didn't"
  const lastRiskThoughtRef = useRef(null);    // dedupe for risk-layer holds (one narration per structId)
  const missStampRef = useRef(null);          // last portfolio-guard hold — the mover ledger reads it

  // ── VIO8 THOUGHT STREAM — what she sees and decides, live for the commander ──
  const [vio8Thoughts, setVio8Thoughts] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('vortex_vio8_thoughts') || '[]');
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      return Array.isArray(raw) ? raw.filter(x => x && x.t > cutoff).slice(0, 60) : [];
    } catch { return []; }
  });
  const thoughtSeqRef = useRef(0);
  const lastThoughtMetaRef = useRef(null);
  const tradeStateRef = useRef(null);
  const pushThought = useCallback((kind, text, extra = {}) => {
    if (!text) return;
    const entry = {
      id: `th_${Date.now().toString(36)}_${(thoughtSeqRef.current += 1).toString(36)}`,
      t: Date.now(),
      kind,
      text: String(text).slice(0, 240),
      ...extra,
    };
    setVio8Thoughts(prev => [entry, ...prev].slice(0, 60));
  }, []);
  useEffect(() => {
    try { localStorage.setItem('vortex_vio8_thoughts', JSON.stringify(vio8Thoughts.slice(0, 60))); } catch { /* storage unavailable */ }
  }, [vio8Thoughts]);

  // ── MOVER RADAR — the missed-opportunity ledger (lib/journal.js) ──────────
  // Flags every ≥5% 24h mover with the desk's exact verdict, so "why didn't we
  // take that move?" is answered with data instead of memory.
  const [moverJournal, setMoverJournal] = useState(() => loadJournal());
  const moverJournalRef = useRef(moverJournal);
  useEffect(() => {
    moverJournalRef.current = moverJournal;
    try { localStorage.setItem(MOVERS.KEY, JSON.stringify(moverJournal)); } catch { /* storage unavailable */ }
  }, [moverJournal]);

  // Categorized token groups — every member passes lib/compliance strict-v1
  const CATEGORIES = {
    CORE:   ['BTC-USDT','ETH-USDT','SOL-USDT','AVAX-USDT','NEAR-USDT','LINK-USDT','ARB-USDT','OP-USDT','TIA-USDT','SUI-USDT','XRP-USDT','ADA-USDT','DOT-USDT','ATOM-USDT','ALGO-USDT','XLM-USDT','HBAR-USDT','VET-USDT','APT-USDT','AR-USDT','LTC-USDT','BCH-USDT','UNI-USDT','PYTH-USDT','JUP-USDT','SEI-USDT','STX-USDT','FIL-USDT','INJ-USDT','TRX-USDT'],
    GAMING: ['SAND-USDT','MANA-USDT','AXS-USDT','GALA-USDT','BEAM-USDT','RON-USDT','PIXEL-USDT','IMX-USDT','SUPER-USDT','ILV-USDT','YGG-USDT','GMT-USDT','APE-USDT','MAGIC-USDT','TLM-USDT'],
    AI:     ['FET-USDT','RNDR-USDT','GRT-USDT','TAO-USDT','WLD-USDT'],
  };

  const filteredCoins = useMemo(() => {
    const list = activeCategory === 'ALL'
      ? marketData
      : marketData.filter(m => CATEGORIES[activeCategory]?.includes(m.symbol));
    return list.sort((a, b) => b.scalpScore - a.scalpScore);
  }, [marketData, activeCategory]);

  // ── EXECUTION OWNERSHIP ──────────────────────────────────────────────────
  // The deterministic machine arms trades now — the LLM narrates. A stray
  // "EXECUTE LONG" from the model is noted once, never armed, unless the active
  // engine itself reached [EXECUTING]/[DAY_EXECUTING] (the dedicated effect
  // below handles the handoff).
  useEffect(() => {
    if (advice?.verdict !== 'EXECUTE LONG') return;
    if (adviceMeta?.id && llmHoldMetaRef.current === adviceMeta.id) return;
    if (adviceMeta?.id) llmHoldMetaRef.current = adviceMeta.id;
    if (selectedStructure?.state === 'EXECUTING' || selectedStructure?.state === 'DAY_EXECUTING') return; // machine handoff covers it
    console.warn(`VORTEX > Vio8 LLM execute not armed — engine state [${selectedStructure?.state || 'NO_DATA'}]`);
    pushThought('rule', `Execute not armed — structure not confirmed ([${selectedStructure?.state || 'NO_DATA'}]; missing: ${selectedStructure?.missing || 'structure'}).`, { symbol: selectedSymbol, tone: 'hold' });
  }, [advice, adviceMeta, selectedStructure, selectedSymbol, pushThought]);

  // Engine state transitions — every change in the machine's diagnosis is narrated
  // once, with the exact missing prerequisite, instead of vague dread language.
  useEffect(() => {
    if (!selectedStructure) return;
    const sym = selectedStructure.symbol || selectedSymbol;
    const key = `${selectedStructure.state}|${selectedStructure.missing || ''}`;
    if (lastIctKeyRef.current.get(sym) === key) return;
    lastIctKeyRef.current.set(sym, key);
    const kind = selectedStructure.strategy === 'DAY_BREAKOUT' || selectedStructure.strategy === 'DAY_CAPITULATION' ? 'day'
      : 'ict';
    pushThought(kind, selectedStructure.narrative || `[${selectedStructure.state}] ${sym}`, { symbol: sym, state: selectedStructure.state });
  }, [selectedStructure, selectedSymbol, pushThought]);

  // ── STRUCTURE EXECUTION — structure-complete handoff to the paper desk ───
  // Fires only on a fresh structure (engine structId locks the setup) so
  // re-evaluations can never double-fire. The risk officer still vets the
  // geometry; the engine context lets its lagging regime veto stand down.
  // The tracker reads each desk's trail + time window from the trade's meta.
  // The portfolio risk layer (lib/risk.js) sits between a green gate and the arm.
  useEffect(() => {
    const struct = selectedStructure;
    if (!struct || !struct.tradeable || !struct.setup) return;
    const executing = struct.state === 'EXECUTING' || struct.state === 'DAY_EXECUTING';
    if (!executing) return;
    const dayNR7 = struct.strategy === 'DAY_BREAKOUT';
    const dayDesk = dayNR7 || struct.strategy === 'DAY_CAPITULATION';
    // structId: engine-provided when available; ICT keeps its sweep+FVG fallback.
    const structId = dayDesk
      ? struct.structId
      : (struct.structId || `${struct.symbol}:${struct.sweep?.time}:${struct.fvg?.time}`);
    if (lastExecutedStructRef.current === structId) return;

    const setup = struct.setup;
    const execAdvice = {
      verdict: 'EXECUTE LONG',
      entry: setup.entry,
      stopLoss: setup.stop,
      target: setup.target,
      risk: setup.rr >= 2 ? 'LOW' : 'MEDIUM',
      rationale: dayDesk
        ? (dayNR7
          ? `Day Breakout: 15m NR7 ${struct.compression?.low}–${struct.compression?.high} broke ${struct.zone?.level} — strong 1m close on ${struct.compression?.volRatio}× volume.`
          : `Day Capitulation: 15m RSI(2) ${struct.oversold?.rsi2} flush in a 1H uptrend — ${struct.oversold?.volRatio}× climax volume.`)
        : `ICT Silver Bullet: sweep ${struct.sweep?.level} → MSS ${struct.mss?.mssLevel} → entry at FVG CE ${setup.entry}.`,
      feeling: struct.narrative,
      tech: dayDesk
        ? (dayNR7
          ? [
              `NR7 bucket ${struct.compression?.low}–${struct.compression?.high} — narrowest of the last 7 completed 15m buckets (${struct.compression?.rangePct}% range)`,
              `Breakout: 1m close above the bucket high, ≤0.4% leash, ≥60% strong-close bar`,
              `Bucket volume ${struct.compression?.volRatio}× its 20-bucket average (need ≥1.5×)`,
            ]
          : [
              `15m RSI(2) at ${struct.oversold?.rsi2} — capitulation (<2) inside a 1H uptrend`,
              `Regime: BTC 1h up · daily SMA10 rising · symbol 4H close > rising EMA20`,
              `Flush volume ${struct.oversold?.volRatio}× the 20-bucket average (need ≥1.5×)`,
            ])
        : [
                `Liquidity sweep: ${struct.sweep?.dir} raid of $${struct.sweep?.level} (wick extreme $${struct.sweep?.extreme})`,
                `Displacement: ${struct.mss?.bodyAtrMult}x ATR body breaking $${struct.mss?.mssLevel} (MSS)`,
                `FVG $${struct.fvg?.bottom}–$${struct.fvg?.top} — ${Math.round((struct.fvg?.mitigatedPct || 0) * 100)}% mitigated`,
              ],
      fund: dayDesk
        ? (dayNR7
          ? [
              `Static stop clamped 2.0–2.5× 15m ATR · resting 4R target · 12h time stop — no trail by design`,
              `No killzone gate — the NR7 bucket itself is the clock; flat within the day`,
            ]
          : [
              `Stop 2.5× 15m ATR · pure peak ratchet (${setup.trail?.dist} pts) armed at +${setup.trail?.armR}R · 8h time stop`,
              `Post-stop cooldown 6h per symbol — the desk refuses to re-catch the same knife`,
            ])
        : [
                `Killzone: ${struct.killzone?.label} — open, ${struct.killzone?.minutesLeft}m left`,
                `Structural bias: ${struct.bias}`,
              ],
      auditCommentary: dayDesk
        ? 'Deterministic day handoff — 15m structure complete, risk officer vetting levels.'
        : 'Deterministic ICT handoff — structure complete, risk officer vetting levels.',
      entryDesc: dayDesk
        ? (dayNR7 ? `NR7 bucket high $${struct.zone?.level} — 1m breakout close` : `Market entry at the RSI(2) flush — $${setup.entry}`)
        : `FVG consequent encroachment $${struct.fvg?.ce}`,
      stopDesc: dayDesk
        ? (dayNR7
          ? `Beyond the NR7 bucket low $${struct.compression?.low} — clamped to the 2.0–2.5×ATR band`
          : `2.5× 15m ATR under the fill — ${setup.riskPct}% risk`)
        : `Beyond the FVG base $${struct.fvg?.bottom} and sweep wick $${struct.sweep?.extreme}`,
      targetDesc: dayDesk
        ? (dayNR7 ? '4R — NR7 measured move' : 'Nominal 8R ceiling — the 2.5×ATR ratchet governs the exit')
        : `${setup.rr}R — ${setup.targetSource === 'LIQUIDITY_POOL' ? 'opposing liquidity pool' : 'structural minimum'}`,
    };

    const gate = validateVio8Signal(execAdvice, {
      direction: hourlyTrend?.direction || 'NEUTRAL',
      kingdomThreat,
      ict: struct.state,
      strategy: struct.strategy,
    });

    const activeCount = tradesTrackRef.current.filter(t => t.status === 'OPEN' || t.status === 'PENDING').length;
    const capFull = activeCount >= MAX_CONCURRENT_POSITIONS;

    if (!gate.ok || capFull) {
      lastExecutedStructRef.current = structId; // stamped — the ruling is logged once
      const why = !gate.ok ? gate.reasons.join(' · ') : `position cap full (${activeCount}/${MAX_CONCURRENT_POSITIONS})`;
      missStampRef.current = { symbol: selectedSymbol, code: capFull ? 'CAP' : 'GATE', detail: why, t: Date.now() };
      pushThought('rule', `[${struct.state}] held on ${selectedSymbol.split('-')[0]} — ${why}.`, { symbol: selectedSymbol, tone: 'hold', state: struct.state });
      console.warn(`VORTEX > ${dayDesk ? 'Day' : 'ICT'} execute held: ${why}`);
      return;
    }

    // ── DAILY-LOSS CIRCUIT BREAKER (lib/breaker.js) — capital guard ──────────
    // A −3% UTC day (realized, fee-included) blocks every NEW arm until the day
    // rolls; open positions keep being managed to their exits. Deliberately NOT
    // stamped — if the same structure still stands after the rollover, it arms.
    if (breaker.tripped) {
      const why = `daily loss ${breaker.lossPct.toFixed(2)}% hit the −3% limit — no new risk until UTC rollover`;
      missStampRef.current = { symbol: selectedSymbol, code: 'BREAKER', detail: why, t: Date.now() };
      const riskKey = `breaker|${breaker.dayUtc}`;
      if (lastRiskThoughtRef.current !== riskKey) {
        lastRiskThoughtRef.current = riskKey;
        pushThought('rule', `[${struct.state}] ${selectedSymbol.split('-')[0]} held by the breaker — ${why}.`, { symbol: selectedSymbol, tone: 'hold', state: struct.state });
        console.warn(`VORTEX > Breaker holds all desks: ${why}`);
      }
      return;
    }

    // ── FEE-AWARE MINIMUM TARGET — round-trip fees are 2×0.1% ───────────────
    // A fixed target closer than 0.45% cannot pay for the trade even when it
    // wins. Dynamic-trail exits (target ∞/absent) are exempt by construction.
    const entryNum = Number(setup.entry);
    const tgtNum = Number(setup.target);
    const tgtPct = entryNum > 0 && Number.isFinite(tgtNum) ? ((tgtNum - entryNum) / entryNum) * 100 : null;
    if (tgtPct !== null && tgtPct < 0.45) {
      lastExecutedStructRef.current = structId; // stamped — geometry ruling, logged once
      missStampRef.current = { symbol: selectedSymbol, code: 'FEE', detail: `target only ${tgtPct.toFixed(2)}% away — cannot clear the 0.45% fee floor`, t: Date.now() };
      pushThought('rule', `[${struct.state}] ${selectedSymbol.split('-')[0]} rejected — target only ${tgtPct.toFixed(2)}% away, cannot clear 2×0.1% round-trip fees.`, { symbol: selectedSymbol, tone: 'hold', state: struct.state });
      console.warn(`VORTEX > ${struct.strategy} target too tight: ${tgtPct.toFixed(2)}% < 0.45% fee floor`);
      return;
    }

    // ── PORTFOLIO RISK LAYER (lib/risk.js) — the C4 ship metric's edge ──────
    // Two structural bleeds measured on the 60d multi-day replay: one event
    // insta-stopping a correlated clone cluster (FET/AGIX/OCEAN = the same bet
    // taken three times), and instant re-entry days after a stop-out. Holds are
    // TEMPORARY — the gate is green and the structure stands, so the desk
    // re-checks every evaluation instead of stamping the structId; the arm
    // clears the moment the book changes (cooldown expiry, correlated fill closed).
    // Day desks mirror their validated replay books on purpose: NR7 has NO
    // post-stop cooldown (research cd0), RSI2 cools 6h per symbol (research
    // cd360), and neither applies the correlation cluster cap — the research
    // book didn't have one, and the cap-3 slot limit already bounds the risk.
    const openNow = tradesTrackRef.current.filter(t => t.status === 'OPEN' || t.status === 'PENDING');
    const closesOf = (sym) => (candleBook?.[sym] || []).slice(-(RISK.CORR_WINDOW + 1)).map(b => b.close);
    const dayCdMs = dayNR7 ? 0 : dayDesk ? DAYDESK.RSI2.COOLDOWN_MIN * 60000 : RISK.COOLDOWN_MS;
    const cooledAt = lastLosingSettle(tradesTrackRef.current, selectedSymbol);
    const cdHit = dayCdMs > 0 && cooledAt != null && Date.now() < cooledAt + dayCdMs;
    let corrHit = null;
    if (!cdHit && !dayDesk) {
      const heldPairs = openNow.filter(t => t.symbol !== selectedSymbol).map(t => [t.symbol, closesOf(t.symbol)]);
      corrHit = correlatedWith(closesOf(selectedSymbol), heldPairs);
    }
    if (cdHit || corrHit) {
      const hoursLeft = Math.ceil((cooledAt + dayCdMs - Date.now()) / 3600000);
      const why = cdHit
        ? `stopped out recently — ${hoursLeft}h of cooldown left`
        : `same bet as open ${corrHit.symbol.split('-')[0]} (ρ ${corrHit.rho})`;
      missStampRef.current = { symbol: selectedSymbol, code: cdHit ? 'COOLDOWN' : 'CORRELATED', detail: why, t: Date.now() };
      const riskKey = `risk|${structId}`;
      if (lastRiskThoughtRef.current !== riskKey) {
        lastRiskThoughtRef.current = riskKey;
        pushThought('rule', `[${struct.state}] ${selectedSymbol.split('-')[0]} held by the risk layer — ${why}.`, { symbol: selectedSymbol, tone: 'hold', state: struct.state });
        console.warn(`VORTEX > Risk layer holds ${selectedSymbol}: ${why}`);
      }
      return; // no stamp — a temporary book state, not a ruling on the structure
    }

    lastExecutedStructRef.current = structId;
    const priceNow = parseFloat(marketDataRef.current.find(m => m.symbol === selectedSymbol)?.price) || setup.entry;
    const context = {
      direction: hourlyTrend?.direction || 'NEUTRAL',
      kingdomThreat,
      balance,
      openTrades: activeCount,
      strategy: struct.strategy,
      ict: struct.state,
      sweep: struct.sweep || null,
      mss: struct.mss || null,
      fvg: struct.fvg || null,
      killzone: struct.killzone?.id || null,
      ...(dayDesk ? { regime: struct.regime, compression: struct.compression, oversold: struct.oversold } : {}),
    };
    const ledgerId = appendVerdict({ symbol: selectedSymbol, price: priceNow, advice: execAdvice, context, gate });
    const placed = addTrade(selectedSymbol, setup.entry, setup.stop, setup.target, ledgerId, {
      strategy: struct.strategy,
      trail: setup.trail || null,
      // Day desks bid a fresh 1m breakout and expire the order in 5 minutes if
      // the tape runs away (research enters at the next open; the mirror is a
      // tight leash). The ICT desk lets its resting order sit unfilled.
      expireMs: dayDesk ? DAYDESK.EXPIRE_MS : null,
      maxHoldMs: dayDesk
        ? (dayNR7 ? DAYDESK.NR7.TIME_STOP_MIN : DAYDESK.RSI2.TIME_STOP_MIN) * 60000
        : null,
    });
    const sized = placed ? ` Sized $${placed.size} — risk $${placed.risk} to the stop.` : '';
    pushThought(dayDesk ? 'day' : 'ict', `[${struct.state}] ${selectedSymbol.split('-')[0]} — buy-limit $${fmtPrice(setup.entry)} · stop $${fmtPrice(setup.stop)} · target $${fmtPrice(setup.target)} (${setup.rr}R).${sized}`, { symbol: selectedSymbol, state: struct.state });
  }, [selectedStructure, selectedSymbol, hourlyTrend, kingdomThreat, balance, candleBook, pushThought, breaker]);

  // Her read after every analysis cycle — the feeling streams straight to the feed.
  useEffect(() => {
    if (!adviceMeta?.id || adviceMeta.id === lastThoughtMetaRef.current) return;
    lastThoughtMetaRef.current = adviceMeta.id;
    const sym = adviceMeta.symbol || selectedSymbol;
    const read = (advice?.feeling || advice?.rationale || '').trim();
    if (read) pushThought('read', read, { symbol: sym, verdict: adviceMeta.verdict || advice?.verdict || null });
    if (adviceMeta.verdict === 'EXECUTE LONG' && adviceMeta.gate && !adviceMeta.gate.ok) {
      pushThought('rule', `Execute blocked on ${sym.split('-')[0]} — ${adviceMeta.gate.reasons.join(' · ')}.`, { symbol: sym, tone: 'hold' });
    }
  }, [adviceMeta, advice, selectedSymbol, pushThought]);

  // Trade lifecycle narration — arms, fills and closes, so the commander never misses a beat.
  useEffect(() => {
    const prev = tradeStateRef.current;
    tradeStateRef.current = new Map(trades.map(t => [t.id, t.status])); // status only
    if (!prev) return; // first snapshot — don't re-narrate the archive
    for (const t of trades) {
      const old = prev.get(t.id);
      const sym = t.symbol.split('-')[0];
      const flags = t.status;
      if (old === undefined) {
        if (t.status === 'PENDING') pushThought('trade', `Order armed — ${sym} buy-limit $${t.entry} · stop $${t.stopLoss} · target $${t.target}.${t.size ? ` Sized $${t.size} — risk $${t.risk} to the stop.` : ''}`, { symbol: t.symbol, tone: 'open' });
        else if (t.status === 'OPEN') pushThought('trade', `Filled — ${sym} in play @ $${t.entry}.`, { symbol: t.symbol, tone: 'open' });
        continue;
      }
      if (old === flags) continue;
      if (!old.startsWith('OPEN') && t.status === 'OPEN') {
        pushThought('trade', `Filled — ${sym} in play @ $${t.entry}.`, { symbol: t.symbol, tone: 'open' });
      } else if (FINAL_TRADE_STATUSES.has(t.status)) {
        const usdNum = t.usdPnl != null ? parseFloat(t.usdPnl) : NaN;
        const usd = Number.isFinite(usdNum) ? ` (${usdNum >= 0 ? '+' : '-'}$${Math.abs(usdNum).toFixed(2)})` : '';
        const pnlPct = t.pnl != null ? ` ${t.pnl}%` : '';
        const flavor = t.status === 'WIN' ? 'target hit' : t.status === 'LOSS' ? 'stop hit' : t.status === 'ABANDONED' ? 'timed out in play' : 'never filled — order expired';
        const tone = t.status === 'WIN' ? 'win' : t.status === 'LOSS' ? 'loss' : t.status === 'ABANDONED' ? 'warn' : 'muted';
        pushThought('trade', `${t.status} — ${sym}${pnlPct}${usd} · ${flavor}.`, { symbol: t.symbol, tone });
      }
    }
  }, [trades, pushThought]);

  // Autopilot plumbing — refs keep the review loop reading live data
  useEffect(() => { marketDataRef.current = marketData; }, [marketData]);
  useEffect(() => { tradesTrackRef.current = trades; }, [trades]);
  useEffect(() => { selectedSymbolRef.current = selectedSymbol; }, [selectedSymbol]);
  useEffect(() => { structureBoardRef.current = structureBoard; }, [structureBoard]);
  useEffect(() => { localStorage.setItem('vortex_autopilot', autopilotOn ? '1' : '0'); }, [autopilotOn]);

  // ── MOVER RADAR TICK — a 10s pass folds board + guards into the ledger ────
  useEffect(() => {
    const collect = () => {
      const res = collectMovers({
        prev: moverJournalRef.current,
        marketData: marketDataRef.current,
        structures: structureBoardRef.current,
        trades: tradesTrackRef.current,
        stamp: missStampRef.current,
        desk: strategy,
        focused: selectedSymbolRef.current,
        now: Date.now(),
      });
      if (!res.changed) return;
      moverJournalRef.current = res.next;
      setMoverJournal(res.next);
      for (const f of res.fresh) {
        const detail = f.verdict === 'TAKEN' ? '' : (f.detail || '');
        const chg = `${f.change >= 0 ? '+' : ''}${Number(f.change).toFixed(2)}%`;
        pushThought('mover', `Mover flag — ${f.symbol.split('-')[0]} ${chg} /24h · ${VERDICT_TEXT[f.verdict] || f.verdict}${detail ? ` — ${detail}` : ''}`, { symbol: f.symbol, tone: 'muted' });
      }
    };
    const timer = setInterval(collect, 10000);
    return () => clearInterval(timer);
  }, [strategy, pushThought]);
  useEffect(() => { localStorage.setItem('vortex_strategy', strategy); }, [strategy]);

  // ── VIO8 AUTOPILOT — she re-ranks the board, thinks out loud, and moves her own desk ──
  const sweepCountRef = useRef(0);
  const lastSweepLeaderRef = useRef(null);
  useEffect(() => {
    if (!autopilotOn) return;

    const review = () => {
      const now = Date.now();
      if (now < manualHoldRef.current) return;                          // commander's desk is sacred
      if (now - lastAutoSwitchRef.current < AUTOPILOT.minGapMs) return;

      const board = marketDataRef.current;
      const ranked = scoreFocusCandidates(board, { trades: tradesTrackRef.current, structures: structureBoardRef.current });
      const current = selectedSymbolRef.current;
      const best = isWorkable(ranked[0]) ? ranked[0] : null;

      sweepCountRef.current += 1;
      const leaderChanged = (best?.symbol || null) !== lastSweepLeaderRef.current;
      const periodic = sweepCountRef.current % 5 === 0;
      lastSweepLeaderRef.current = best?.symbol || null;

      if (!best) {
        const closest = ranked[0];
        const detail = closest ? ` Closest: ${closest.symbol.split('-')[0]} — [${closest.state}] missing ${closest.missing || 'nothing'}.` : '';
        if (leaderChanged || periodic) pushThought('scan', `Scanned ${board.length} desks — nothing clears my workable bar (${AUTOPILOT.workableFloor}).${detail}`, { tone: 'muted' });
        return;
      }

      if (best.symbol === current) {
        if (periodic) pushThought('scan', `Scanned ${board.length} desks — ${current.split('-')[0]} still leads the board (${best.score}). This desk is mine.`, { symbol: current });
        return;
      }

      const incumbent = ranked.find(r => r.symbol === current);
      const delta = incumbent ? best.score - incumbent.score : null;
      if (incumbent && delta < AUTOPILOT.switchMargin) {
        if (leaderChanged || periodic) pushThought('scan', `Watching ${best.symbol.split('-')[0]} (${best.score}) — ${best.reasons.join(' · ')} — but only ${delta.toFixed(1)} pts over my ${current.split('-')[0]} desk; my shift bar is ${AUTOPILOT.switchMargin}. I hold.`, { symbol: current });
        return;
      }

      lastAutoSwitchRef.current = now;
      setAutopilotNotice({ symbol: best.symbol, from: current, reasons: best.reasons, manual: false, t: now });
      console.info(`VORTEX > Vio8 autopilot: focus ${current.split('-')[0]} → ${best.symbol.split('-')[0]} (${best.reasons.join(', ')})`);
      pushThought('scan', `Desk shift: ${current.split('-')[0]} → ${best.symbol.split('-')[0]} (${best.score}) — ${best.reasons.join(' · ')}${incumbent ? ` · beats my desk by ${delta.toFixed(1)} pts` : ' · my old desk fell out of the hunt'}.`, { symbol: best.symbol });
      setSelectedSymbol(best.symbol);
      setActiveCategory('ALL'); // the board follows her desk
    };

    const boot = setTimeout(review, 8000);
    const timer = setInterval(review, AUTOPILOT.reviewMs);
    return () => { clearTimeout(boot); clearInterval(timer); };
  }, [autopilotOn, pushThought]);

  const toggleAutopilot = () => {
    const next = !autopilotOn;
    setAutopilotOn(next);
    if (!next) setAutopilotNotice(null);
    pushThought('scan', next
      ? 'Autopilot engaged. I take the board and hunt my own desk.'
      : "Autopilot off — I hold my desk and wait for the commander's call.", { tone: 'muted' });
  };

  // Desk selector — switches the deterministic engine feeding the board.
  const toggleStrategy = (next) => {
    if (next === strategy) return;
    setStrategy(next);
    lastExecutedStructRef.current = null; // fresh desk — the old desk's rulings don't bind it
    manualHoldRef.current = 0;            // and she may re-rank immediately
    pushThought('scan', next === 'DAY_BREAKOUT'
      ? 'Desk switch — DAY BREAKOUT. 15m NR7 compression → 1m close through the bucket high; static stop, 4R target, 12h leash.'
      : next === 'DAY_CAPITULATION'
        ? 'Desk switch — DAY CAPITULATION. 15m RSI(2) < 2 flush in a BTC-bull uptrend; 2.5×ATR stop, ratchet trail, 8h leash, 6h cooldown.'
        : 'Desk switch — ICT PRECISION. Back to the 1H Silver Bullet: sweep → displacement → FVG inside killzones.', { tone: 'muted' });
  };

  // Round-12 BTC trend-gate switch — bypasses the 1h uptrend and SMA10-rising
  // reads in the day desks; the daily position wall and every asset gate stand.
  const toggleBtcTrendGate = () => {
    const next = !btcTrendGate;
    setBtcTrendGate(next);
    lastExecutedStructRef.current = null; // the ruling regime changed — re-rank from scratch
    pushThought('scan', next
      ? "BTC trend gates re-armed — the desk waits for the king's hourly uptrend and a rising daily again."
      : 'BTC trend gates off — only the daily position wall (close > SMA10) stands; the 1h uptrend and SMA10-rising parks are bypassed.', { tone: 'muted' });
  };

  // Manual picks freeze her hunting for a few minutes — the human always wins
  const handleSelectSymbol = (symbol) => {
    manualHoldRef.current = Date.now() + AUTOPILOT.manualHoldMs;
    if (autopilotOn) {
      setAutopilotNotice({ symbol, from: selectedSymbol, reasons: [`manual override — autopilot holds ${AUTOPILOT.manualHoldMs / 60000} min`], manual: true, t: Date.now() });
      pushThought('scan', `Commander takes ${symbol.split('-')[0]} — I freeze my hunt for ${AUTOPILOT.manualHoldMs / 60000} minutes.`, { symbol, tone: 'muted' });
    }
    setSelectedSymbol(symbol);
  };

  const handleResetAudit = () => {
    resetTrades();
    setVio8Thoughts([]);
    setMoverJournal([]);
    moverJournalRef.current = [];
    lastIctKeyRef.current = new Map();
    lastExecutedStructRef.current = null;
    try { localStorage.removeItem('vortex_vio8_thoughts'); } catch { /* ignore */ }
    try { localStorage.removeItem(MOVERS.KEY); } catch { /* ignore */ }
  };

  const selectedData = useMemo(() => (
    marketData.find(m => m.symbol === selectedSymbol) || marketData[0]
  ), [marketData, selectedSymbol]);

  return (
    <div className="app-shell w-full flex flex-col bg-navy text-slate-200 overflow-hidden relative">
      <div className="zen-bg" />
      <div className="zen-orb" />

      {/* Command deck — brand, feed health, live KPI rail */}
      <CommandBar
        balance={balance}
        availableBalance={availableBalance}
        trades={trades}
        stats={stats}
        breaker={breaker}
        scoreboard={scoreboard}
        kingdomThreat={kingdomThreat}
        strategy={strategy}
        isDay={isDay}
        btcTrendGate={btcTrendGate}
        autopilotOn={autopilotOn}
        selectedSymbol={selectedSymbol}
        status={status}
        priceSource={priceSource}
        candleSource={candleSource}
        fundamentals={fundamentals}
        fearGreed={fearGreed}
        isAnalyzing={isAnalyzing}
        showDevMode={showDevMode}
        setShowDevMode={setShowDevMode}
      />
      
      {/* Tab bar — workspace switcher + persistent desk controls */}
      <nav className="h-10 shrink-0 flex items-center gap-1 px-2 md:px-4 border-b border-white/5 z-40 overflow-x-auto no-scrollbar">
        {['CHART', 'DESK', 'INTEL', 'MOVERS'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "text-[12px] font-black uppercase tracking-widest px-3.5 py-2.5 md:py-1.5 rounded-sm border transition-all shrink-0",
              activeTab === tab
                ? "border-cyan-neon bg-cyan-neon/10 text-cyan-neon"
                : "border-transparent text-white/45 hover:text-white/60"
            )}
          >
            {tab}
          </button>
        ))}
      
        <div className="ml-auto flex items-center gap-2 pl-3 shrink-0">
          {/* Desk selector */}
          <div className="flex items-center gap-1">
            {[
              { id: 'ICT_PRECISION', label: 'ICT Sniper', active: "border-cyan-neon bg-cyan-neon/10 text-cyan-neon" },
              { id: 'DAY_BREAKOUT', label: 'Day Breakout', active: "border-rose-400 bg-rose-400/10 text-rose-300" },
              { id: 'DAY_CAPITULATION', label: 'Day Cap', active: "border-sky-400 bg-sky-400/10 text-sky-300" },
            ].map(s => (
              <button
                key={s.id}
                onClick={() => toggleStrategy(s.id)}
                className={cn(
                  "text-[11px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-sm border transition-all shrink-0",
                  strategy === s.id ? s.active : "border-white/5 text-white/40 hover:text-white/50 hover:border-white/20"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
      
          {/* BTC trend-gate switch — day desks only (round-12 ablation lever) */}
          {isDay && (
            <button
              onClick={toggleBtcTrendGate}
              title={btcTrendGate
                ? 'BTC 1h uptrend + daily SMA10 rising required (shipped default)'
                : 'BTC trend gates bypassed — 1h uptrend and SMA10-rising parks are off; only close > daily SMA10 still stands'}
              className={cn(
                "text-[11px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-sm border transition-all shrink-0",
                btcTrendGate
                  ? "border-white/5 text-white/40 hover:text-white/50 hover:border-white/20"
                  : "border-amber-500/60 bg-amber-500/10 text-amber-400"
              )}
            >
              {btcTrendGate ? 'BTC trend: On' : 'BTC trend: Off'}
            </button>
          )}

          {/* Autopilot toggle + notice */}
          <button
            onClick={toggleAutopilot}
            className={cn(
              "text-[11px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-sm border transition-all shrink-0",
              autopilotOn
                ? "border-cyan-neon bg-cyan-neon/10 text-cyan-neon"
                : "border-white/5 text-white/40 hover:text-white/50 hover:border-white/20"
            )}
          >
            {autopilotOn ? 'Vio8: Hunting' : 'Vio8: Off'}
          </button>
          {autopilotOn && autopilotNotice && (
            <span className={cn(
              "hidden xl:block text-[11px] font-mono shrink-0 max-w-[240px] truncate",
              autopilotNotice.manual ? "text-white/40" : "text-cyan-neon/70"
            )}>
              {autopilotNotice.manual ? 'HOLD' : 'FOCUS'} → {autopilotNotice.symbol.split('-')[0]} — {autopilotNotice.reasons.join(' · ')}
            </span>
          )}
      
          {/* Selected symbol chip — live mark */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-sm border border-white/10 bg-white/[0.03] shrink-0">
            <span className="text-[12px] font-black text-white tracking-wide">{selectedSymbol.split('-')[0]}</span>
            <span className="text-[12px] font-mono text-slate-300">${selectedData?.price ?? '—'}</span>
            <span className={cn(
              "text-[12px] font-mono font-bold",
              parseFloat(selectedData?.change) >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {selectedData?.change}%
            </span>
          </div>
        </div>
      </nav>

      {/* Tabbed workspace — CHART / DESK / INTEL (all mounted; the inactive tabs stay hidden so their feeds and chart state persist) */}
      <main className="flex-1 min-h-0 flex flex-col p-3 overflow-hidden">
        <div className={cn('flex-1 min-h-0 flex flex-col', activeTab !== 'CHART' && 'hidden')}>
          <ChartTab
            filteredCoins={filteredCoins}
            selectedSymbol={selectedSymbol}
            selectedData={selectedData}
            handleSelectSymbol={handleSelectSymbol}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            candles={candles}
            dayBook={dayBook}
            day1hBook={day1hBook}
            trades={trades}
            selectedStructure={selectedStructure}
            isDayBreakout={isDayBreakout}
            isDayCapitulation={isDayCapitulation}
          />
        </div>

        <div className={cn('flex-1 min-h-0 flex flex-col', activeTab !== 'DESK' && 'hidden')}>
          <DeskTab
            advice={advice}
            adviceMeta={adviceMeta}
            isAnalyzing={isAnalyzing}
            selectedData={selectedData}
            trades={trades}
            stats={stats}
            balance={balance}
            availableBalance={availableBalance}
            setSelectedTrade={setSelectedTrade}
            handleResetAudit={handleResetAudit}
            autopilotOn={autopilotOn}
            toggleAutopilot={toggleAutopilot}
            autopilotNotice={autopilotNotice}
            vio8Thoughts={vio8Thoughts}
            selectedSymbol={selectedSymbol}
            marketData={marketData}
            hourlyTrend={hourlyTrend}
            kingdomThreat={kingdomThreat}
            breaker={breaker}
            scoreboard={scoreboard}
          />
        </div>

        <div className={cn('flex-1 min-h-0 flex flex-col', activeTab !== 'INTEL' && 'hidden')}>
          <IntelTab
            filteredCoins={filteredCoins}
            marketData={marketData}
            selectedSymbol={selectedSymbol}
            handleSelectSymbol={handleSelectSymbol}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            news={news}
            fundamentals={fundamentals}
            fearGreed={fearGreed}
            globalStats={globalStats}
            trending={trending}
            diagnostics={diagnostics}
            showDevMode={showDevMode}
            status={status}
            candleSource={candleSource}
            priceSource={priceSource}
          />
        </div>

        <div className={cn('flex-1 min-h-0 flex flex-col', activeTab !== 'MOVERS' && 'hidden')}>
          <MoversTab
            movers={moverJournal}
            selectedSymbol={selectedSymbol}
            handleSelectSymbol={handleSelectSymbol}
            desk={strategy}
            now={ictClock}
            regime={deskRegime}
          />
        </div>


      </main>


      <div className="fixed top-0 left-0 w-full h-[1px] bg-cyan-neon/20 animate-scanline pointer-events-none z-[100] opacity-30" />
      {/* Trade Details Modal */}
      <TradeModal 
        trade={selectedTrade} 
        onClose={() => setSelectedTrade(null)} 
      />
    </div>
  );
}

export default App;
