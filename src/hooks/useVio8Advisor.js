import { useState, useEffect, useRef } from 'react';
import { appendVerdict, buildScorecard, scorecardForPrompt, validateVio8Signal } from '../lib/vio8';
import { calculateATR } from '../lib/engine';
import { remainingNotional } from '../lib/sizing';
import { UPLINK, bookKey, cooldownMs, pickModels, rollLedger, shouldFire } from '../lib/uplink';
import { GROQ_API_URL, GROQ_MODELS, GROQ_API_KEY } from '../lib/groq';

const LEDGER_KEY = 'vio8.uplink.ledger'; // cross-tab budget ledger (localStorage)

// Strict structured outputs — gpt-oss on Groq supports constrained decoding, so
// the sampler CANNOT emit invalid JSON. The old json_object mode could, and the
// 400 that followed was Groq rejecting the model's own malformed generation.
const VIO8_SCHEMA = {
  type: 'object',
  properties: {
    tech: { type: 'array', items: { type: 'string' } },
    fund: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    verdict: { type: 'string', enum: ['WAIT', 'MONITOR', 'EXECUTE LONG'] },
    feeling: { type: 'string' },
    rationale: { type: 'string' },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    target: { type: 'number' },
    entryDesc: { type: 'string' },
    stopDesc: { type: 'string' },
    targetDesc: { type: 'string' },
    auditCommentary: { type: 'string' },
  },
  required: ['tech', 'fund', 'risk', 'verdict', 'feeling', 'rationale', 'entry', 'stopLoss', 'target', 'entryDesc', 'stopDesc', 'targetDesc', 'auditCommentary'],
  additionalProperties: false,
};

// Shown only when there is no prior read to keep — a throttled uplink must never
// wipe her thesis mid-session (silence beats amnesia).
const INTERFERENCE_ADVICE = {
  tech: ["Analyzing structure...", "Syncing RSI data", "Calculating EMA"],
  fund: ["Scanning market sentiment...", "Fear & Greed index loading"],
  risk: "MEDIUM",
  verdict: "MONITOR",
  feeling: "Signal interference detected. Re-establishing secure uplink to Vio8 Core.",
  entry: 0,
  stopLoss: 0,
  target: 0,
  entryDesc: "Calculating...",
  stopDesc: "Calculating...",
  targetDesc: "Calculating...",
  auditCommentary: "Vio8: Standing by for data sync.",
};

// The uplink ledger lives in localStorage so every open tab of the terminal
// shares one budget — two tabs must not double the burn rate.
const readUplinkLedger = () => {
  try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || 'null'); } catch { return null; }
};
const writeUplinkLedger = (ledger) => {
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch { /* storage unavailable — in-memory pacing only */ }
};

/**
 * useVio8Advisor - The Sovereign Tactical Intelligence of Vortex.Zen
 */
export const useVio8Advisor = (marketData, news, fundamentals, fearGreed, selectedSymbol = 'BTC-USDT', hourlyTrend = null, trades = [], balance = 10000, kingdomThreat = 'PEACE', candles = [], ict = null, strategy = 'ICT_PRECISION') => {
  const [advice, setAdvice] = useState(null);
  const [adviceMeta, setAdviceMeta] = useState(null); // { id, gate, t } — links the advice to its ledger entry
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Governor state: cadence anchors + per-model spend and cooldowns.
  const uplink = useRef({ lastFire: 0, price: 0, state: null, book: '', spent: {}, dayKey: '', cooldowns: {} });

  const generateAdvice = async () => {
    if (!GROQ_API_KEY) return; // no uplink key configured — stay dark, keep the last read
    if (!marketData || marketData.length === 0) return;

    const asset = marketData.find(m => m.symbol === selectedSymbol) || marketData[0];
    if (!asset || asset.price === '0.00') return;

    // ── SUSTAINABILITY GOVERNOR ───────────────────────────────────────────────
    // One shared Groq org key with per-model ceilings — the uplink paces itself
    // against the day's budget instead of discovering the wall via 429s.
    // Order: visibility → cadence/material gate → model health + pace.
    const now = Date.now();
    const priceNum = parseFloat(asset.price) || 0;
    const st = uplink.current;
    const ledger = rollLedger(readUplinkLedger(), now);
    st.dayKey = ledger.dayKey;
    st.spent = ledger.spent;
    st.lastFire = Math.max(st.lastFire, ledger.lastFireAt || 0);
    const engineState = ict?.state || null;
    const book = bookKey(trades);
    if (!shouldFire({
      now,
      lastFire: st.lastFire,
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      price: priceNum, lastPrice: st.price,
      state: engineState, lastState: st.state,
      book, lastBook: st.book,
      strategy,
    }).fire) return;
    const chain = pickModels(GROQ_MODELS, st, now);
    if (chain.length === 0) return; // every model cooling or pace-spent — stay quiet, keep the last read

    setIsAnalyzing(true);
    st.lastFire = now; st.price = priceNum; st.state = engineState; st.book = book;
    writeUplinkLedger({ dayKey: st.dayKey, spent: st.spent, lastFireAt: st.lastFire });

    try {
      const bars = Array.isArray(candles) ? candles : [];
      const h1 = hourlyTrend || {};

      // ── Derived market intelligence — decision quality = input quality ──
      const atr1m = bars.length > 15 ? calculateATR(bars, 14) : 0;
      const atrPct = priceNum > 0 && atr1m > 0 ? (atr1m / priceNum) * 100 : null;
      const momPct = (minutesBack) => {
        const ref = bars[bars.length - 1 - minutesBack];
        return bars.length > minutesBack && ref?.close > 0 ? ((priceNum / ref.close) - 1) * 100 : null;
      };
      const mom15 = momPct(15);
      const mom60 = momPct(60);

      const pct = (v, digits = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
      const fmtPrice = (n) => (Number.isFinite(n) ? (n >= 1 ? n.toFixed(2) : n.toPrecision(4)) : '—');

      const emaSide = Number.isFinite(h1.emaDist)
        ? `${Math.abs(h1.emaDist).toFixed(2)}% ${h1.emaDist > 0 ? 'BELOW' : 'ABOVE'} the 1H EMA20`
        : 'unknown';
      const swingRoomHigh = h1.swingHigh && priceNum > 0 ? ((h1.swingHigh - priceNum) / priceNum) * 100 : null;
      const swingRoomLow = h1.swingLow && priceNum > 0 ? ((priceNum - h1.swingLow) / priceNum) * 100 : null;

      // Suggested bracket — the active deterministic engine's levels take priority
      // when a setup is armed (ICT FVG encroachment); the risk officer still vets
      // whatever ends up in the JSON. The clamp windows mirror the officer gate.
      let stopRef = (ict?.setup?.stop) || (h1.swingLow && h1.swingLow < priceNum ? h1.swingLow : priceNum * 0.985);
      const stopCapPct = 0.02;      // mirrors GATE.maxStopPct
      const stopFloorPct = 0.0015;  // …and its minStopPct floor
      const stopMidPct = 0.015;     // comfortable reset when outside the band
      if (priceNum - stopRef > priceNum * stopCapPct) stopRef = priceNum * (1 - stopCapPct);
      if (priceNum - stopRef < priceNum * stopFloorPct) stopRef = priceNum * (1 - stopMidPct);
      const entryRef = ict?.setup?.entry || priceNum;
      const minTargetMult = 1.005;  // fee floor
      const minTargetRR = 2;        // intraday geometry pays 2R on this desk
      const targetRef = ict?.setup?.target || Math.max(priceNum * minTargetMult, priceNum + minTargetRR * (priceNum - stopRef));

      // Sentiment wire — previously fetched but never consulted; now it's in the diet
      const fgLine = fearGreed ? `${fearGreed.value} (${fearGreed.label})` : 'unavailable';
      const fundLine = fundamentals
        ? `Rank #${fundamentals.rank ?? '—'} | MCap ${fundamentals.marketCap ? `$${(fundamentals.marketCap / 1e9).toFixed(1)}B` : '—'} | 7d ${pct(fundamentals.change7d)} | 30d ${pct(fundamentals.change30d)}`
        : 'unavailable';
      const headlines = (Array.isArray(news) ? news : [])
        .slice(0, 3)
        .map(n => `"${String(n?.title || '').slice(0, 90)}"`)
        .filter(s => s.length > 2)
        .join(' | ') || 'wire silent';

      // Market breadth across the 42-symbol scanner
      const upCount = marketData.filter(m => parseFloat(m.change) > 0).length;
      const btcChange = marketData.find(m => m.symbol === 'BTC-USDT')?.change;

      // The book
      const openTrades = trades.filter(t => t.status === 'OPEN' || t.status === 'PENDING');
      const positionsLine = openTrades.length
        ? openTrades.map(t => `${t.symbol.split('-')[0]} ${t.status === 'OPEN' ? 'in-play' : 'pending'} @ $${t.entry}${t.status === 'OPEN' && t.pnl != null ? ` (now ${t.pnl}%)` : ''}`).join(' | ')
        : 'NONE — flat';
      const committed = openTrades.reduce((acc, t) => acc + remainingNotional(t), 0);
      const availableCapital = balance - committed;

      const performanceLedger = scorecardForPrompt(buildScorecard(), asset.symbol);

      // ── STRATEGY DOCTRINE ─────────────────────────────────────────────────────
      // One ladder: the ICT Silver Bullet. The day desks carry their own
      // deterministic signals but narrate through the same machine contract
      // (state / bias / setup / missing / narrative) as the precision desk.
      const hierarchyBlock = `PRIMARY DECISION HIERARCHY — ICT SILVER BULLET (the only gates that matter):
The deterministic engine has ALREADY run this ladder and reports its result below:
  STEP A LIQUIDITY SWEEP  — did price raid a recent swing high/low?
  STEP B DISPLACEMENT     — did a strong body candle (>= 1.4x ATR) break market structure (MSS)?
  STEP C FAIR VALUE GAP   — is price returning to a clean, unmitigated FVG inside a killzone?
Structure leads. You narrate the machine's state and dress its levels — you never re-gate it.`;

      const alignmentBlock = `VERDICT ALIGNMENT (strict — the machine's state is binding):
- Engine state [EXECUTING] → verdict MUST be "EXECUTE LONG" using the engine's bracket from
  the ICT block (you may tighten levels, never push them outside the officer policy).
- [WAITING_FOR_KILLZONE] → "MONITOR": structure is valid and parked for the window.
- [FVG_MITIGATION] or [DISPLACEMENT_DETECTED] → "MONITOR", naming the FVG zone and what you wait for.
- [SCANNING_SWEEP] (or no data) → "WAIT", and state verbatim what the machine is missing.
- KINGDOM THREAT WAR/CATASTROPHE → MONITOR regardless.`;

      const policyBlock = `RISK OFFICER POLICY: stop 0.15%–2% below entry, target >= 0.5% above entry, reward:risk >= 1.5.
The 1H BEARISH-regime veto stands down ONLY while the engine state is [EXECUTING].
FEES: round trip costs 0.2% — targets under 0.5% of clean room are noise.`;

      const selfReviewLine = `SELF-REVIEW: if your ledger record on this symbol is negative over 3+ closes, demand BOTH
[EXECUTING] state AND pressure > 60%; after 2 straight losses require reward:risk >= 2.`;

      const stateBlock = `ICT STATE MACHINE (deterministic — trust this over everything else):
- State: [${ict?.state || 'NO_DATA'}] | Bias: ${ict?.bias || 'NEUTRAL'} | Tradeable now: ${ict?.tradeable ? 'YES' : 'NO'}
- Killzone: ${ict?.killzone ? (ict.killzone.active ? `${ict.killzone.label} — OPEN (${ict.killzone.minutesLeft}m left)` : `CLOSED — next ${ict.killzone.next ? `${ict.killzone.next.label} in ~${ict.killzone.startsInMin}m` : '—'}`) : '—'}
- Liquidity raid: ${ict?.sweep ? `${ict.sweep.dir} sweep of $${fmtPrice(ict.sweep.level)} (wick extreme $${fmtPrice(ict.sweep.extreme)}, ${ict.sweep.ageBars} bars ago)` : 'none detected'}
- Displacement/MSS: ${ict?.mss ? `${ict.mss.dir} MSS through $${fmtPrice(ict.mss.mssLevel)} — body ${ict.mss.bodyAtrMult}x ATR (${ict.mss.ageBars} bars ago)` : 'not yet'}
- FVG: ${ict?.fvg ? `${fmtPrice(ict.fvg.bottom)}–$${fmtPrice(ict.fvg.top)} | CE $${fmtPrice(ict.fvg.ce)} | ${(ict.fvg.mitigatedPct * 100).toFixed(0)}% mitigated${ict.fvg.inZone ? ' | PRICE IN ZONE' : ''}${ict.fvg.ceTapped ? ' | CE tapped' : ''}` : 'none live'}
- Missing prerequisite: ${ict?.missing || 'none — structure complete'}
- Engine bracket: ${ict?.setup ? `entry $${fmtPrice(ict.setup.entry)} · stop $${fmtPrice(ict.setup.stop)} · target $${fmtPrice(ict.setup.target)} (${ict.setup.rr}R, risk ${ict.setup.riskPct}%)` : 'not armed'}`;

      const feelingSpec = `First-person tactical briefing to the commander that QUOTES the engine state tag ([SCANNING_SWEEP]/[DISPLACEMENT_DETECTED]/[FVG_MITIGATION]/[WAITING_FOR_KILLZONE]/[EXECUTING]) and names the missing prerequisite when one exists (1-2 sentences, present tense — this streams live to his thought feed)`;

      const prompt = `
You are "Vio8", the Sovereign Tactical Intelligence of the Vortex.Zen Terminal.
MANDATE: grow a $10,000 paper account with high-precision intraday spot longs. Every verdict is
recorded in a public ledger; every EXECUTE LONG is auto-executed and scored after fees.
You are accountable for net P&L — protect capital first, profit second.

${hierarchyBlock}

LAGGING INDICATORS — CONTEXT ONLY:
RSI thresholds, EMA distance, Buying Pressure and 24h change are color for your narrative.
They may NEVER veto a valid engine-confirmed structure, and they may never manufacture one.
Banned: vague dread like "structure turning hostile", or any WAIT/MONITOR that fails to name
the exact missing prerequisite.

${alignmentBlock}

${policyBlock}
${selfReviewLine}

STEP 5 DISCIPLINE: a WAIT or MONITOR is only valid when it names the missing prerequisite.
There are no frozen verdicts — there is only the next step of the ladder.

YOUR PERFORMANCE LEDGER (outcomes of your own past signals — study it, it is your resume):
${performanceLedger}

MARKET SNAPSHOT:
- Asset: ${asset.symbol} @ $${asset.price} (24h ${asset.change}%)
- Kingdom Threat: ${kingdomThreat} | BTC 24h: ${btcChange ?? '—'}% | Breadth: ${upCount}/${marketData.length} symbols green
- 1H Structure: ${h1.direction || 'NEUTRAL'} | 1H RSI ${Number.isFinite(h1.rsi) ? h1.rsi.toFixed(0) : '—'} | Price ${emaSide}
- 1H levels: swing high $${fmtPrice(h1.swingHigh)} (${pct(swingRoomHigh)} away) | swing low $${fmtPrice(h1.swingLow)} (${pct(swingRoomLow)} below)

${stateBlock}

PRICE DYNAMICS:
- Short RSI: ${Number.isFinite(asset.rsi) ? asset.rsi.toFixed(1) : '—'} | Buying Pressure: ${asset.volumePressure || 0}% | Volume: ${asset.volumeTrend || 'NORMAL'}
- Momentum: 15m ${pct(mom15)} | 1h ${pct(mom60)} | 1m ATR: ${atrPct != null ? `${atrPct.toFixed(2)}% of price` : '—'}

SENTIMENT & FLOW:
- Fear & Greed: ${fgLine}
- Fundamentals: ${fundLine}
- Headlines: ${headlines}

YOUR BOOK:
- Positions: ${positionsLine}
- Balance: $${balance.toFixed(2)} | Available capital: $${availableCapital.toFixed(2)}

Return a JSON object with EXACTLY these fields:
{
  "tech": ["Insight 1", "Insight 2", "Insight 3"],
  "fund": ["Sentiment 1", "Sentiment 2", "Sentiment 3"],
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "verdict": "WAIT" | "MONITOR" | "EXECUTE LONG",
  "feeling": "${feelingSpec}",
  "rationale": "1-sentence strategic summary naming the ICT prerequisite satisfied or missing",
  "entry": ${entryRef},
  "stopLoss": ${stopRef},
  "target": ${targetRef},
  "entryDesc": "Tactical rationale for entry",
  "stopDesc": "Rationale for stop level",
  "targetDesc": "Rationale for target level",
  "auditCommentary": "Vio8 update on performance and heat"
}

CRITICAL: If your verdict is "WAIT", you MUST set entry, stopLoss, and target to 0. Only provide real numbers if the verdict is "MONITOR" or "EXECUTE LONG". Return ONLY numbers for numeric fields.`;

      // Model chain: strongest brain first; a 429 cools that model for its own
      // reset window and the chain moves on — the desk never goes dark.
      let rawContent = null;
      let lastError = null;
      for (const model of chain) {
        try {
          const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.1,
              reasoning_effort: 'low',    // narrate the machine — deep thinking is wasted burn
              max_completion_tokens: 1200, // TPM/TPD are token budgets; cap the runaway
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'vio8_verdict', strict: true, schema: VIO8_SCHEMA },
              },
            })
          });

          // Groq answers a 429 with its own reset window on the headers.
          if (response.status === 429) {
            st.cooldowns[model] = Date.now() + cooldownMs({
              retryAfter: response.headers.get('retry-after'),
              resetTokens: response.headers.get('x-ratelimit-reset-tokens'),
            });
          }

          if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Groq ${response.status} (${model}): ${detail.slice(0, 160)}`);
          }

          const json = await response.json();
          st.spent[model] = (st.spent[model] || 0) + (json.usage?.total_tokens || UPLINK.SPEND_ESTIMATE);
          writeUplinkLedger({ dayKey: st.dayKey, spent: st.spent, lastFireAt: st.lastFire });
          console.info(`Vio8 uplink: ${model} · ${json.usage?.total_tokens ?? '?'} tok · model day ${st.spent[model]}/${UPLINK.MODEL_DAILY_BUDGET}`);
          rawContent = JSON.parse(json.choices[0].message.content);
          break;
        } catch (err) {
          lastError = err;
          console.warn(`Vio8 uplink: ${model} unavailable — degrading to next model. ${err.message}`);
        }
      }
      if (!rawContent) throw lastError || new Error('Vio8 uplink: all models failed');

      if (selectedSymbol !== asset.symbol) return;

      // Accountability: log the verdict + context, run the risk officer on EXECUTEs.
      const context = {
        rsi: asset.rsi,
        pressure: asset.volumePressure,
        change: asset.change,
        direction: h1.direction || 'NEUTRAL',
        emaDist: h1.emaDist ?? null,
        kingdomThreat,
        balance,
        openTrades: openTrades.length,
        atrPct: atrPct != null ? parseFloat(atrPct.toFixed(3)) : null,
        mom15: mom15 != null ? parseFloat(mom15.toFixed(2)) : null,
        mom60: mom60 != null ? parseFloat(mom60.toFixed(2)) : null,
        fearGreed: fearGreed?.value ?? null,
        breadth: upCount,
        strategy, // routes the risk officer to DAY_GATE vs GATE
        ict: ict?.state || null, // regime veto stands down on [EXECUTING]/[DAY_EXECUTING]
      };
      const gate = rawContent.verdict === 'EXECUTE LONG' ? validateVio8Signal(rawContent, context) : null;
      const ledgerId = appendVerdict({ symbol: asset.symbol, price: parseFloat(asset.price), advice: rawContent, context, gate });

      setAdvice(rawContent);
      setAdviceMeta({ id: ledgerId, gate, t: Date.now(), symbol: asset.symbol, verdict: rawContent.verdict });
    } catch (err) {
      console.error("Vio8 Uplink Error:", err);
      // A throttled uplink keeps her last read on screen — only a cold start
      // (no prior advice at all) falls back to the interference placeholder.
      setAdvice(prev => prev || INTERFERENCE_ADVICE);
    } finally {
      setIsAnalyzing(false);
    }
  };

  useEffect(() => {
    // Fresh symbol earns a fresh read (cadence re-anchored; budget still gates).
    uplink.current.lastFire = 0;
    uplink.current.price = 0;
    uplink.current.state = null;
    // Deliberate reset on symbol switch — a stale verdict must never render under a new symbol.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAdvice(null);
    setAdviceMeta(null);
    setIsAnalyzing(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedSymbol]);

  // Desk switch — a fresh engine must never inherit the other desk's verdict.
  useEffect(() => {
    uplink.current.lastFire = 0;
    uplink.current.price = 0;
    uplink.current.state = null;
    // Deliberate reset on desk switch — an old engine's verdict must not leak across desks.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAdvice(null);
    setAdviceMeta(null);
    setIsAnalyzing(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [strategy]);

  useEffect(() => {
    generateAdvice();
    const timer = setInterval(generateAdvice, 60000);
    // Hidden tabs sleep — a forgotten background terminal must not buy tokens.
    const onVisibility = () => { if (document.visibilityState === 'visible') generateAdvice(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [marketData, news, fundamentals, fearGreed, selectedSymbol]);

  return { advice, isAnalyzing, adviceMeta };
};
