#!/usr/bin/env node
// ── DAY-TRADING STRATEGY RESEARCH LAB ─────────────────────────────────────────
// The strategy foundry for the day desk. Where backtest.mjs replays the retired
// legacy skeleton, this harness exists to FIND edge: it evaluates a battery of
// long-only intraday
// strategy families over the shared 1m kline cache, sweeps their parameters,
// and grades every variant with split-half robustness (both halves of the
// window must earn) so a lucky month can never top the table.
//
// STRATEGY FAMILIES (long-only, flat by night, fees + slippage charged)
//   S1  MR15-RSI2     15m RSI(2) capitulation buy in a 1h uptrend (Connors-style)
//   S2  MR15-BB       lower Bollinger(20,2) 15m touch reversion to the mid-band
//   S3  VWAP-REV      stretched below the UTC-day VWAP -> bid up to the VWAP
//   S4  EMA20H-PULL   trend pullback: 1h uptrend, tag of the 1h EMA20, reclaim
//   S5  DONCH-BO      new 30/60/120-minute high on a volume surge, trend-aligned
//   S6  PDL-SWEEP     prior-day-low liquidity sweep -> reclaim (daily raid)
//   S7  NR7-SQ        NR7 compression on 15m, breakout of the narrow bar
// Round-2 refinements of the families that survived the first battery:
//   S1R MR15-RSI2-R2  climax-volume filter, ATR%-of-price floor, structural
//                     exits (3R / 3R+trail / pure trail), post-stop cooldown
//   S3R VWAP-REV-R2   capped loss geometry (sized stop + VWAP-touch / capped)
//   S6R PDL-SWEEP-R2  shallow sweeps only, trend gate, EOD flat
//   S7R NR7-SQ-R2     volume surge hard-required, wider stop floor, trail exit
// Round-3 local sweeps around the two portfolio champions (NR7 f1.5 3R and
// the RSI2<3 trail geometry) — freeze the winner, probe its neighborhood:
//   S7R2 NR7-SQ-R3    stop floor x R multiple x time stop neighborhood
//   S1R2 MR15-RSI2-R3 trail distance x arming threshold x cooldown
// Round-4 — the 120d tape exposed regime dependence (both families bleed in
// choppy/bleeding tapes); gate the winners with the BTC regime flags:
//   S7R3 NR7-SQ-R4    f2 4R/3R ts12h x gate off|btc1h|btcDaily10
//   S1R3 MR15-RSI2-R4 trail2.5x geometry x same gate axis
// Round-5 — entry quality: strong-close bars, per-symbol 4H structure, volume:
//   S7R5 NR7-SQ-R5    btcD10 gate x sym4h x strong-close x vol(1.5|2.0) [+ts24]
//   S1R5 MR15-RSI2-R5 btcD10 gate x sym4h on/off
// Round-6 — gate sharpening: the residual H1 bleed is dead-cat bounces that
// close one day above the daily SMA10 while the average is still falling:
//   S7R6 NR7-SQ-R6    f(1.5|2.0) x gate d10|d10r (SMA10 rising)|d10p (held 4/5)
//   S1R6 MR15-RSI2-R6 trail2.5x a0.5 4h:on cd(180|360) x gate d10r|d10p
// Round-7 — books, not gates: d10r/d10p came back negative (the tape pays the
// counter-trend bounce), so freeze the d10 winner; test the shared-book
// question instead (NR7 priority + RSI2 fills idle slots) and a rarer-
// capitulation RSI2 probe to relieve slot competition:
//   S1R7 MR15-RSI2-R7 rsi2<1|2 x cooldown 180|360
//   MIX  MIXED-R1     NR7v6f2 (priority -1) + RSI2v6, shared cap-3 book
// Round-8 — grid speed: the 15m grid only shows a flush after its bucket
// completes; the same flush on 5m is visible while it is happening:
//   S8   MR5-RSI2     RSI2v6 geometry on the 5m grid, 2-3h leash, cd sweep
//   MIX5 NR7v6f2 priority + MR5-RSI2 fill, shared cap-3 book (slot test)
// Round-9 — VWAP fade: round 8 failed because faster grids catch the fall;
// round 9 asks the opposite — buy the dip below the SESSION VWAP (the S3
// stretch idea) once a completed 15m bucket shows exhaustion:
//   S9   VWAP-FADE-15M session VWAP15 stretch k x RSI2<rsiTh x stop x exit x ts
//   MIX9 NR7v6f2 priority + RSI2v6 + vwap fade, shared cap-3 book (slot test)
// Round-10 — momentum: every desk so far buys weakness (squeeze, flush, fade).
// Nothing bought a RUNNER — a vertical mover like a +11% day was structurally
// out of vocabulary. S10 buys strength: a 1m close busting the 12h/24h high on
// ignition volume, leash-capped so we never pay up too far, ridden with a
// trail (or a plain 3R):
//   S10   MOM-BO win(12|24)h x leash(0.75|2)% x stop(1.5|2.5)xATR15
//         x exit(3R|trail2.5 arm1R) x 4h(on|off) x ts(8|24)h — gate d10r, cd240
//   MIX10 NR7v6f2 priority + RSI2v6 + MOM-BO, shared cap-3 book (slot test)
// Round-11 — opening range: every desk waits for a completed 15m event (squeeze
// / flush / fade), but the day's FIRST information arrives at the open. An
// opening window after the anchor (00:00 UTC ~ Asia open, 13:30 UTC = US open)
// sets the range; the first 1m close back above its high is the entry; risk is
// the range floor (or an ATR cap when the range is wide); the ride exits at the
// UTC close (EOD flat, never overnight):
//   S11   ORB anchor(asia|us) x win(15|30)m x stop(range|atrp) x exit(3R|trail)
//         x gate(d10r|off) x session(all|Monday-Asia) — 64 variants, cd240
//   MIX11 NR7v6f2 priority + RSI2v6 + ORB, shared cap-3 book (slot test) —
//         instantiated only if a standalone survivor is frozen
// Pre-registered frozen-winner rule (stated before any run, same as 9-10):
//   >=15 trades per half, BOTH halves net-positive, portfolio expectancy >=
//   the shipped RSI2 desk's same-window expectancy, max DD <= the frozen $375
//   book band; winner = best min(H1,H2) among survivors; it must hold on BOTH
//   the 50d and the 120d window to port.
// Round-12 — gate ablation: does the BTC gate earn its keep? The user asks it
// directly (the BTC-1h read parks ~45-50% of hours). This is NOT a new edge —
// it isolates ONE gate component on the two SHIPPED geometries (signal code
// frozen: NR7v6f2 f2 d10 / RSI2v7 <2 cd360 d10r). 'cur' (the shipped compound
// gate) sits in the same battery as the S7R6_2_d10 / S1R7_2_360 baselines:
//   S12   GATE-ABL  Nr7(no1h|daily|off) x Rsi2(no1h|daily|off)
//         no1h  = drop btcUp only (the daily reads stand)
//         daily = drop the daily reads only (btcUp stands)
//         off   = no BTC gate at all
// Pre-registered rule (stated before any run, same discipline as 9-11):
//   The 1h component is KEPT unless a no-1h ablation holds BOTH halves positive
//   (>=15 trades/half) on BOTH windows, with expectancy >= the shipped compound
//   desk's same-window expectancy and max DD within the frozen $375 book band.
//   'daily'/'off' rows are mechanism reading only — they can never port.
// Round-12b (user directive): the live switch's OFF position also bypasses
// btcD10r. For the capitulation desk that shape is "btcD10 only" (btcUp and
// btcD10r both bypassed); for the NR7 desk it equals no1h (it never read d10r).
// S12_rsi2_d10 characterizes the new OFF shape — mechanism reading only, it can
// never port (the switch is a manual lever; the shipped default keeps the gate).
// Round-13 — the scalp canon (user directive: research effective scalp
// strategies and implement). The web canon reduces to a handful of expressions
// and this lab has already refused most of them: S2 BB-touch, S3/S9 VWAP
// stretch-fade, S4 1h-EMA20 tag, S5 Donchian, R10 momentum chase, R11 ORB.
// The two canonical expressions that have never run here are now tested on a
// scalp grid — 15m structure, 1m trigger, fees + slippage charged:
//   S13 RCLM-BOU  VWAP bounce/reclaim continuation: the completed 15m bucket
//       tests the session VWAP15 from above ('keep' = touched and closed back
//       above; 'reclaim' = undercut >0.1 ATR then closed back above); entry on
//       the first bullish 1m close holding the line within 1 ATR of it; exit
//       2R | trail1.5ATR arm1R | vwapLost (first 15m close back under the
//       line); stop struct(-0.25 ATR under the bucket low, clamped) | 1.5ATR;
//       session all|us (13:30-20:00 UTC); ts6h, cd240.
//   S13 EPULL     fast 9/21-EMA pullback continuation: 15m EMA9 > EMA21 with
//       EMA21 rising (vs 3 buckets back); the completed bucket tags the fast
//       (or deep: slow) line and closes back above it without being extended;
//       entry on the first bullish 1m close reclaiming the bucket close; exit
//       2R | trail1.5ATR arm1R; stop struct | 1.5ATR; session all|us; ts6h,
//       cd180.
//   Both sub-families carry the desk DNA: gate6 d10 (btcUp + btcD10), 1h
//   trend up, 4h structure up, ATR%-of-price floor 0.002, long-only.
// Pre-registered rule (stated before any run, same discipline as 9-12):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery) and max DD <=
//   the frozen $375 book band. Survivors rank by min(H1,H2); the best one is
//   frozen and re-run in-battery. Everything that misses is mechanism reading
//   only and cannot port.
//
// Round-14 — session drift (user directive: research effective DAY-TRADING
// strategies and implement). Thirteen rounds made every desk and refusal
// event-triggered: squeeze, flush, fade, breakout, opening range, VWAP hold,
// EMA tag. The other half of the day-trading canon is TIME-based: the
// session's first half-hour return predicts the rest of the day (market
// intraday momentum — Gao-Han-Li-Zhou, JFE 2018; the effect persists for
// BTC intraday series per Shen 2022), and the documented crypto session
// seasonality says the drift concentrates in the US hours. Never tested
// here. S14 buys the SESSION SIGN at the half-hour mark, rides it to the
// close, and is flat by night:
//   S14 DRIFT fire(30|60) x cond(up|down) x stop(atr|struct) x
//       exit(eod|usclose|trail) x gate(d10|off) — 48 variants, cd600
//   fire30: first 1m bar in 14:00-14:05 UTC (30m after the 13:30 US anchor)
//   whose close sits on the cond side of the session-open price (open of
//   the first tape bar >= 13:30 that day); fire60: same at 14:30-14:35.
//   cond up = momentum (close > session open); down = the reversal read
//   (close < session open, bought for the close). stop atr = 1.5xATR15;
//   struct = under the day low -0.25 ATR (clamped 0.75-2.5 ATR). exit eod =
//   flat at the UTC close (never overnight); usclose = out on the first bar
//   >= 20:00 UTC (the US close; the literature's last-half-hour window sits
//   just inside it); trail = 1.5xATR trail armed at 1R, still flat by night.
//   House DNA carried: 4h structure up, 1h trend up, ATR% floor 0.002,
//   long-only. Priority = biggest divergence from the session open in the
//   cond's direction (the book fills the strongest drift first).
// Pre-registered rule (stated before any run, same discipline as 9-13):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery) and max DD <=
//   the frozen $375 book band. Survivors rank by min(H1,H2); the best one is
//   frozen and re-run in-battery. gate:off rows measure the raw drift
//   without the BTC regime wall — mechanism reading only, never a port.
//   Everything that misses is mechanism reading only and cannot port.
//
// Round-15 — reversal-read robustness (user directive: "I want that round" —
// the follow-up promised in the round-14 closeout). Round 14 refused its
// study row `dr 60 down struct eod d10` on three grounds: the 50d H1 missed
// by $8.97 (of a +$211.43 net), the 120d max DD ($477.17) broke the $375
// band, and one symbol (TLM) carried ~83% of the 120d portfolio net. This
// round freezes that exact geometry (fire60 x cond down x stop struct x exit
// eod x gate d10 — same sessionDriftSignal, same priority, same DNA) and
// asks one question: does the reversal read survive a concentration collar?
//   S15 RC-COLLAR symcd(base|any24|any48) x topn(cap|day1) — 6 variants,
//   cd600 base / 1440 / 2880.
//     symcd base = the round-14 cooldown (only losing exits arm 600m).
//     symcd any24|any48 = the per-symbol cooldown arms after ANY exit (24h /
//     48h) — one name cannot re-fire day after day and carry the book.
//     topn day1 = at most ONE new drift entry per UTC day across the book
//     (the day's strongest divergence only — kills the 3-correlated-bets
//     day); topn cap = the round-14 book (no day cap).
// The collar is the standard robustness answer (leave-one-out / jackknife:
// re-test with the suspect unit removed; Wikipedia "Jackknife resampling").
// The control row (base x cap) re-runs beside the frozen S14 row in the SAME
// battery and must reproduce it byte-for-byte — same signal function, inert
// collar knobs; the S14 battery rows double as that in-battery control.
// Pre-registered rule (stated before any run, same discipline as 9-14):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery), max DD <= the
//   frozen $375 book band, AND no single symbol carries > 50% of the
//   variant's portfolio net in either window. The best survivor (rank by
//   min(H1,H2)) is frozen and re-run as a leave-one-out — each window with
//   that window's top-contributing symbol removed from the universe via
//   --exclude-symbols — and must still clear the same conjuncts in the
//   stripped runs; otherwise it is refused. Everything that misses is
//   mechanism reading only and cannot port.
//
// Round-16 — NR7 volume-gate forensics + ablation (user directive: the AXS
// mover. A +14.83% day parked with 8/9 asset gates green — the only red gate
// was the NR7 compression-bucket volume wall: "bucket at 0.54x (need >=1.5x)").
// Two questions, answered separately in the same battery:
// (1) FORENSICS — what does the >=1.5x wall actually leave on the frozen tape?
//     Every NR7-geometry signal (signal code frozen: nr7v6 f2, strong close,
//     sym4h up, gate d10, 4R, ts12h) is bucketed by volRatio = bucket v15 / its
//     20-bucket average; the four bands tile the entire signal set:
//       S16_FRN_B0 volRatio [0, 0.5)   B1 [0.5, 1.0)   B2 [1.0, 1.5)
//       (the shipped row S7R6_2_d10 IS the [1.5, inf) band — same battery)
//     These rows are mechanism reading only — they can NEVER port.
// (2) ABLATION — is the wall in the right place, and is bucket volume even the
//     right ignition proxy? Two axes, otherwise the shipped geometry:
//       S16_ABL  threshold >= 1.25x | 1.0x | off (dropped)
//       S16_TAPE ignition on the breakout 1m bar: v[k] >= kT x vAvg20[k],
//                kT in {2,3}; the compression-bucket wall is dropped.
// Pre-registered rule (stated before any run, same discipline as 9-15):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery), max DD <= the
//   frozen $375 book band, AND no single symbol carries > 50% of the variant's
//   portfolio net in either window. Survivors rank by min(H1,H2); the best one
//   is frozen and re-run as a leave-one-out (each window with that window's
//   top-contributing symbol removed via --exclude-symbols) and must still clear
//   the same conjuncts; otherwise it is refused. The FRN bands are forensics
//   only — they can never port, whatever they show. Everything else that
//   misses is mechanism reading only and cannot port.
//
// Round-17 — EXPAND: expansion-bar breakout with TAPE ignition (user directive:
// "ensure no trade setup and no trade opportunity is missed; we are leaving
// money on the table due to refused trades"). The honest reframe: the refusals
// are the edge (round 16 proved the NR7 sub-1.5x cohort is negative-EV), but the
// desk speaks only ONE language — completed 15m COMPRESSION buckets — so a mover
// like AXS is only ever seen as "a compression break with a weak bucket". The
// leak the user points at is COVERAGE, not loosening. Rounds 10 (S10
// rolling-high MOM) and 11 (S11 ORB) already refused momentum-on-strength, and
// every momentum family here measures ignition on the TRAILING completed bucket
// (v15[b] >= 1.5 x volAvg15[b]) — the same wall that refused AXS. Round 17 tests
// the untested cell: momentum whose ignition is measured on the BREAKOUT TAPE.
//   S17 EXPAND-15 break of a WIDE-RANGE expansion bucket (range15 >= kExp x
//       atr15, the complement of NR7), first 1m close above its high within a
//       leash, strong breakout bar, TAPE ignition v[k] >= kT x vAvg20[k];
//       kExp(1.25|1.5) x leash(0.4%|1.0%) x kT(2|3) x exit(3R|trail); ts12h,
//       cd240. House DNA: sym4h up, 1h trend up, ATR%-floor, gate d10.
//   S17 EXPAND-5 the same structure on the 5m grid (range5/atr5/h5/l5);
//       kExp(1.25|1.5) x kT(2|3) x exit(3R|trail); ts4h, cd120 (round 8 tested
//       fast-grid REVERSION and failed; fast-grid momentum has never run).
//   DEF controls: DEF_bucketvol swaps tape ignition for the old
//       v15[nb]>=1.5xvolAvg15[nb] rule, DEF_novol drops volume — together they
//       answer "is the DEFINITION the fix?". gateoff (no BTC gate) is mechanism
//       reading only — it can never port (the round-12/14 convention).
// Pre-registered rule (stated before any run, same discipline as 9-16):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery), max DD <= the
//   frozen $375 book band, AND no single symbol carries > 50% of the variant's
//   portfolio net in either window. Survivors rank by min(H1,H2); the best one
//   is frozen and re-run as a leave-one-out (each window with that window's
//   top-contributing symbol removed via --exclude-symbols) and must still clear
//   the same conjuncts; otherwise it is refused. gateoff rows are mechanism
//   reading only — they can never port. Everything else that misses is
//   mechanism reading only and cannot port.
//
// Round-18 — RETEST: the break-and-retest continuation (user directive: "proceed
// on opportunity capture"). Coverage thread: rounds 16/17 bracketed the
// refused-mover question from the compression and expansion sides; the one
// CLASSICAL setup this harness has never tested is the breakout RETEST — buy the
// pullback that HOLDS a level already broken, not the break itself. That is the
// second chance a refused breakout needs: the desk declines a weak-volume break
// (lab16), but if price then steps back to the broken level and defends it in an
// uptrend, the level has proven itself and the entry is a different, later,
// higher-quality event. S18 RETEST builds it on the 15m grid: a prior 15m
// SWING-HIGH bucket (anchor rb buckets back) that has since been broken by a
// completed 15m close, then a 1m bar whose low touches the level (<= LVL*(1+tol))
// and whose close reclaims just above it (LVL <= c[k] <= LVL*(1+leash)) with a
// strong close — the retest-hold bar. House DNA: sym4h up, 1h trend up, ATR%-floor,
// gate d10. Sweep rb(3|5|7) x leash(0.4%|0.8%) x exit(3R|trail); cd240.
//   DEF controls (isolate the RETEST itself): DEF_breakEntry enters on the break
//       of the same older level (no retest) — the retest's marginal value;
//       DEF_noswing drops the swing-high requirement. gateoff (no BTC gate) is
//       mechanism reading only — it can never port (round-12/14/17 convention).
// Pre-registered rule (stated before any run, same discipline as 9-17):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery), max DD <= the
//   frozen $375 book band, AND no single symbol carries > 50% of the variant's
//   portfolio net in either window. Survivors rank by min(H1,H2); the best one
//   is frozen and re-run as a leave-one-out (each window with that window's
//   top-contributing symbol removed via --exclude-symbols) and must still clear
//   the same conjuncts; otherwise it is refused. gateoff rows are mechanism
//   reading only — they can never port. Everything else that misses is
//   mechanism reading only and cannot port.
//
// Round-19 — FILTERS on the shipped desks (user directive: "study more strategies
// to improve our trade success rate, on scalp and day trading"; chosen axis =
// overlay filters, not new entries, because rounds 16-18 refused coverage and the
// edge keeps proving to be SELECTIVITY). No new entry logic: the two shipped
// geometries are frozen byte-for-byte and every row is that base PLUS one guard:
//   Base NR7  = S7R6_2_d10  (gate6 d10 · nr7v6Signal f2 · 4R · ts12h)
//   Base RSI2 = S1R7_2_360  (gate6 d10r · rsi2v6Signal <2 · ratchet · cd360)
// Three evidence-backed filter axes, one factor at a time against each base:
//   TOD  — time-of-day session window on the ENTRY minute (UTC):
//          asia 00:00-08:00 | us 13:30-20:00 (the documented session effects)
//   VREG — volatility-regime band: the completed bucket's atr15 vs its trailing
//          5-day (480-bucket) mean, causal + NaN-safe. calm <0.8 | mid [0.8,1.5]
//          | hot >1.5 (the classic regime filter: trade the vol you can trust)
//   RS   — relative-strength leadership: the symbol's trailing 12h/24h return must
//          exceed BTC's over the SAME timestamps (buy the leaders, not the laggards)
// Two blind combo rows per base (tod_us+vreg_mid, tod_us+rs_24h) are registered
// BEFORE any run and never hand-picked from results.
// Controls: S19_<base>_ctrl must reproduce the shipped row byte-for-byte — the
// in-battery control that proves the filter wrapper is inert when no filter is on.
// Pre-registered rule (stated before any run, same discipline as 9-18):
//   a variant ports only if it holds BOTH halves positive (>=15 trades/half)
//   on BOTH the 50d and the 120d window, with portfolio expectancy >= the
//   shipped day compound book's same-window expectancy (pooled net/trades of
//   the S7R6_2_d10 and S1R7_2_360 rows in the same battery), max DD <= the
//   frozen $375 book band, AND no single symbol carries > 50% of the variant's
//   portfolio net in either window. Survivors rank by min(H1,H2); the best one
//   is frozen and re-run as a leave-one-out (each window with that window's
//   top-contributing symbol removed via --exclude-symbols) and must still clear
//   the same conjuncts; otherwise it is refused. Everything that misses is
//   mechanism reading only and cannot port.
//
// ROUND 21 — STRESSED-COST × REGIME-GATED re-validation (pre-registered)
// Round-20 verdict: at base cost the two shipped desks are ~flat-to-negative on
// the 120d tape and materially negative out-of-sample (BTC -7.6%) — they are
// long beta. Round 21 changes nothing except adding ONE book-level brake, a BTC
// medium-term (4H) regime gate, on top of the frozen shipped bases:
//   S21_<base>_ctrl  = shipped base unchanged (must reproduce it byte-for-byte)
//   S21_<base>_g4h   = base AND BTC 4H close>EMA20 AND EMA20 rising
//   S21_<base>_g4hnd = base AND NOT (BTC 4H close<EMA20 AND EMA20 falling)
// Pre-registered rule (stated before any run): at MID cost
//   (fee 0.1%/side + slip 0.05%/fill + spread 0.08%/round-trip)
// a gated variant ports iff, on ALL THREE windows {IS-50, IS-120, OOS-120}:
//   (a) portfolio net >= 0; and
//   (b) on the two BULL windows (IS-50, IS-120) BOTH halves >= 0 with >=15
//       trades per half (the edge must be real in the regimes we trade); and
//   (c) no single symbol carries > 50% of portfolio net (net<=0 windows aside).
// A legitimately stood-down bear window may have few trades — that is the gate
// working, not a failure. Controls must reproduce the shipped mid-cost rows.
// Survivors rank by worst-window net; the best is frozen and re-run leave-one-out
// on all three windows; anything else is refused (mechanism reading only).
//
// EXECUTION MODEL (deliberately conservative, one convention everywhere)
//   - Signal at close of 1m bar k  ->  market entry at open of bar k+1
//   - Slippage 2bp on every market fill (both sides), fee 0.1% per side
//   - --spread (default 0, i.e. the frozen baseline) charges half the round-trip
//     bid/ask spread on the buy and half on the sell, so a real book can be priced
//   - Stops are market orders: gap through the stop fills at the open, else at
//     the stop level; when a bar touches BOTH stop and target the stop wins
//   - Targets are resting limit sells (fill at the target level)
//   - Dynamic exits (VWAP touch / SMA5 / RSI2>70 / end-of-day) fill at the bar
//     close — the pessimistic choice
//   - One position per symbol; time stops per variant; nothing held overnight
//     except the variants that explicitly allow it (max hold is a knob)
//   - --portfolio K ALSO replays a live-style book: at most K concurrent
//     positions across the universe, filled best-signal-first (plan.priority),
//     with the per-symbol post-stop cooldown when the variant asks for one
//
// NO LOOKAHEAD DISCIPLINE
//   15m/1h indicator values are read from the last COMPLETED bucket only
//   (mapped per minute by lastDone16/1h arrays); the forming bucket's close is
//   never consulted. Rolling highs used as breakout levels EXCLUDE the signal
//   bar. Every access is compilable from data known at the close of bar k.
//
// Usage:
//   node scripts/research-day.mjs [--days 50] [--warmup-days 12]
//     [--symbols ALL|BTC-USDT,ETH-USDT] [--exclude-symbols TLM,AR] [--only S1,S4] [--fee 0.001]
//     [--slip 0.0002] [--notional 1000] [--concurrency 3] [--end <epoch-ms>]
//     [--top 30] [--min-half-trades 15] [--no-threat] [--portfolio 3]
//     [--dump-signals <path>]   (body-ok signal log for scripts/verify-daydesk.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMBOLS, BINANCE_MAP, BINANCE_SKIP } from '../src/lib/universe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CFG = {
  days: 50,
  warmupDays: 12,
  symbols: null,
  excludeSymbols: null,   // base symbols removed from the universe (round-15 jackknife runs)
  only: null,             // e.g. ['S1','S4']
  fee: 0.001,             // per side
  slip: 0.0002,           // per market fill
  spread: 0,              // round-trip bid/ask spread; half charged on entry, half on exit
  notional: 1000,
  concurrency: 3,
  endMs: null,
  top: 30,
  minHalfTrades: 15,
  portfolioCap: 0,        // >1 = also simulate a live-style book (cap K concurrent slots)
  threatGate: true,       // mirror the live desk: no entries during WAR/CATASTROPHE
  dumpSignals: null,      // path: body-ok signal log for the daydesk port-fidelity check
  cacheDir: path.join(ROOT, '.backtest-cache'),
  outDir: path.join(ROOT, 'backtest-reports'),
};

const args = process.argv.slice(2);
for (let a = 0; a < args.length; a++) {
  const key = args[a]?.replace(/^--/, '');
  if (key === 'no-threat') { CFG.threatGate = false; continue; }
  const val = args[++a];
  if (key == null || val == null) { console.warn(`Missing value for --${key}`); break; }
  switch (key) {
    case 'days': CFG.days = Number(val); break;
    case 'warmup-days': CFG.warmupDays = Number(val); break;
    case 'symbols': CFG.symbols = val.toUpperCase() === 'ALL' ? null : val.split(',').map(s => s.trim()); break;
    case 'exclude-symbols': CFG.excludeSymbols = val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean); break;
    case 'only': CFG.only = val.split(',').map(s => s.trim().toUpperCase()); break;
    case 'fee': CFG.fee = Number(val); break;
    case 'slip': CFG.slip = Number(val); break;
    case 'spread': CFG.spread = Number(val); break;
    case 'notional': CFG.notional = Number(val); break;
    case 'concurrency': CFG.concurrency = Math.max(1, Math.min(4, Number(val))); break;
    case 'end': CFG.endMs = Number(val); break;
    case 'top': CFG.top = Number(val); break;
    case 'min-half-trades': CFG.minHalfTrades = Number(val); break;
    case 'portfolio': CFG.portfolioCap = Math.max(0, Number(val) | 0); break;
    case 'dump-signals': CFG.dumpSignals = val; break;
    default: console.warn(`Unknown flag: --${key}`);
  }
}

const NOW = Number.isFinite(CFG.endMs) ? CFG.endMs : Date.now();
const WINDOW_MS = CFG.days * 86400e3;
const WINDOW_START = NOW - WINDOW_MS;
const HALF_SPLIT = WINDOW_START + WINDOW_MS / 2;
const FETCH_START = NOW - (CFG.days + CFG.warmupDays) * 86400e3;

// ── SMALL UTILS ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt$ = (n) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const banner = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));
const clampi = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ── KLINE FETCHING (shared disk cache with the other harnesses) ───────────────
async function fetchJson(url, attempt = 1) {
  try {
    // Hard per-request ceiling: a stalled response must not wedge a long
    // backfill (undici's fetch has no default timeout, so a single hung
    // socket previously froze the whole fetch range forever).
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 418) && attempt <= 3) {
          console.warn(`  rate-limited (${res.status}) - backing off ${attempt * 5}s`);
          await sleep(attempt * 5000);
          return fetchJson(url, attempt + 1);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();   // body read stays inside the abort window
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    if (attempt <= 3) { await sleep(1500 * attempt); return fetchJson(url, attempt + 1); }
    throw err;
  }
}

const klinesUrl = (pair, startMs, endMs) =>
  `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;

async function fetchRange(pair, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  let reqs = 0;
  while (cursor < endMs) {
    const batch = await fetchJson(klinesUrl(pair, cursor, endMs));
    reqs++;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const k of batch) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const lastOpen = batch[batch.length - 1][0];
    if (batch.length < 1000) break;
    cursor = lastOpen + 60000;
    await sleep(60);
  }
  return { rows: out, reqs };
}

async function loadPair(pair) {
  const cacheFile = path.join(CFG.cacheDir, `1m_${pair}.json`);
  let cached = [];
  if (fs.existsSync(cacheFile)) {
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cached = []; }
  }

  let reqs = 0;
  const endMs = NOW;
  if (cached.length === 0) {
    const { rows, reqs: r } = await fetchRange(pair, FETCH_START, endMs);
    reqs += r;
    cached = rows;
  } else {
    const first = cached[0][0];
    const last = cached[cached.length - 1][0];
    if (first > FETCH_START + 60000) {
      const { rows, reqs: r } = await fetchRange(pair, FETCH_START, first - 1);
      reqs += r;
      cached = rows.concat(cached);
    }
    if (last < endMs - 5 * 60000) {
      const { rows, reqs: r } = await fetchRange(pair, last + 60000, endMs);
      reqs += r;
      if (rows.length) cached = cached.concat(rows);
    }
  }

  const seen = new Map();
  for (const row of cached) if (!seen.has(row[0]) || seen.get(row[0])[1] === 0) seen.set(row[0], row);
  let rows = [...seen.values()].sort((a, b) => a[0] - b[0]);
  // Drop any bar that opens inside the still-forming current minute. Do it in
  // ONE pass: trimming with `rows = rows.slice(0, -1)` in a loop is O(n^2)
  // and, when NOW sits well behind the cache floor (an out-of-sample window),
  // copies ~170k elements per iteration and effectively hangs the run.
  let hi = rows.length;
  while (hi > 0 && rows[hi - 1][0] + 60000 > NOW) hi--;
  if (hi < rows.length) rows = rows.slice(0, hi);

  fs.mkdirSync(CFG.cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(rows));
  return { rows, reqs };
}

// ── VECTORIZED INDICATOR SERIES (single pass, no lookahead) ───────────────────
function emaSeries(vals, period) {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += vals[i];
  let e = sum / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function smaSeries(vals, period) {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdSeries(vals, period) {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = vals[i];
    sum += x; sumSq += x * x;
    if (i >= period) { const y = vals[i - period]; sum -= y; sumSq -= y * y; }
    if (i >= period - 1) {
      const mean = sum / period;
      const varr = Math.max(0, sumSq / period - mean * mean);
      out[i] = Math.sqrt(varr);
    }
  }
  return out;
}

function rsiSeries(closes, period) {
  const n = closes.length;
  const out = new Float64Array(n).fill(NaN);
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
}

function atrSeries(h, l, c, period) {
  const n = c.length;
  const out = new Float64Array(n).fill(NaN);
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
}

/** Rolling max of vals[k-period..k-1] (current bar excluded) — O(n) deque. */
function rollMaxPrev(vals, period) {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  const dq = new Int32Array(n);
  let head = 0, tail = 0; // [head, tail) hold indices, decreasing vals
  for (let i = 0; i < n; i++) {
    // window is [i-period, i-1]
    const exp = i - period;
    if (head < tail && dq[head] < exp) head++;
    if (i >= 1) {
      const vi = vals[i - 1];
      while (tail > head && vals[dq[tail - 1]] <= vi) tail--;
      dq[tail++] = i - 1;
      const wStart = Math.max(0, i - period);
      if (i - 1 - wStart + 1 >= 1 && i >= period) out[i] = vals[dq[head]];
      else if (i >= period) out[i] = vals[dq[head]];
    }
    if (head === tail && i >= period) { /* empty deque cannot happen: window nonempty */ }
  }
  return out;
}

function rollMinPrev(vals, period) {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    const exp = i - period;
    if (head < tail && dq[head] < exp) head++;
    if (i >= 1) {
      const vi = vals[i - 1];
      while (tail > head && vals[dq[tail - 1]] >= vi) tail--;
      dq[tail++] = i - 1;
      if (i >= period) out[i] = vals[dq[head]];
    }
  }
  return out;
}

// ── BUCKET FOLDING ────────────────────────────────────────────────────────────
/**
 * Fold the 1m series into `ms`-wide buckets. Returns bucket arrays plus a
 * per-minute bucket-ordinal map (`ord`) and a completion flag aligned to the
 * minute grid (1 = this minute closes the bucket). Buckets are indexed by
 * order of appearance; with contiguous 1m data this is 1:1 with floor(t/ms).
 */
function foldBuckets(time, o, h, l, c, v, ms) {
  const n = time.length;
  const bt = [], bo = [], bh = [], bl = [], bc = [], bv = [];
  const ord = new Int32Array(n);
  const complete = new Uint8Array(n);
  let cur = -1;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(time[i] / ms);
    if (b !== cur) { cur = b; bt.push(b * ms); bo.push(o[i]); bh.push(h[i]); bl.push(l[i]); bc.push(c[i]); bv.push(v[i]); }
    else {
      if (h[i] > bh[bh.length - 1]) bh[bh.length - 1] = h[i];
      if (l[i] < bl[bl.length - 1]) bl[bl.length - 1] = l[i];
      bc[bc.length - 1] = c[i];
      bv[bv.length - 1] += v[i];
    }
    ord[i] = bt.length - 1;
    complete[i] = (time[i] + 60000) % ms === 0 ? 1 : 0;
  }
  return {
    t: Float64Array.from(bt), o: Float64Array.from(bo), h: Float64Array.from(bh),
    l: Float64Array.from(bl), c: Float64Array.from(bc), v: Float64Array.from(bv),
    ord, complete, m: bt.length,
  };
}

/** last-done bucket index per minute: completed bucket b at minute k when the
 *  bucket containing k is finished, else the previous bucket (b-1). -1 = none. */
function lastDoneMap(ord, complete, m) {
  const n = ord.length;
  const out = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const b = complete[i] ? ord[i] : ord[i] - 1;
    out[i] = b >= 0 && b < m ? b : -1;
  }
  return out;
}

// ── PREPARE PER SYMBOL ────────────────────────────────────────────────────────
function prepare(symbol, rows) {
  const n = rows.length;
  const time = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
        l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    time[i] = r[0]; o[i] = r[1]; h[i] = r[2]; l[i] = r[3]; c[i] = r[4]; v[i] = r[5];
  }
  let evalStart = 0;
  while (evalStart < n && time[evalStart] < WINDOW_START) evalStart++;
  if (evalStart >= n - 100) return null;
  // ── 15m grid ──
  const b15 = foldBuckets(time, o, h, l, c, v, 900e3);
  const i15 = lastDoneMap(b15.ord, b15.complete, b15.m);
  const rsi2_15 = rsiSeries(b15.c, 2);
  const rsi14_15 = rsiSeries(b15.c, 14);
  const sma5_15 = smaSeries(b15.c, 5);
  const sma20_15 = smaSeries(b15.c, 20);
  const std20_15 = stdSeries(b15.c, 20);
  const ema9_15 = emaSeries(b15.c, 9);
  const ema21_15 = emaSeries(b15.c, 21);
  const atr15 = atrSeries(b15.h, b15.l, b15.c, 14);
  const volAvg15 = smaSeries(b15.v, 20);
  const range15 = new Float64Array(b15.m);
  for (let i = 0; i < b15.m; i++) range15[i] = b15.h[i] - b15.l[i];
  // ── round-19 volatility-regime plane: atr15 vs its trailing 5-day (480-bucket)
  // mean, built with a NaN-safe ring buffer (the ATR series opens with 14 NaNs
  // that would poison a plain smaSeries). Causal: a bucket only sees prior ones.
  const atrAvg15 = new Float64Array(b15.m).fill(NaN);
  {
    const W = 480; let sum = 0, cnt = 0, wlen = 0, wr = 0;
    const win = new Float64Array(W).fill(NaN);
    for (let i = 0; i < b15.m; i++) {
      const x = Number.isFinite(atr15[i]) ? atr15[i] : NaN;
      if (wlen < W) { win[(wr + wlen) % W] = x; wlen++; }
      else { const old = win[wr]; win[wr] = x; wr = (wr + 1) % W; if (Number.isFinite(old)) { sum -= old; cnt--; } }
      if (Number.isFinite(x)) { sum += x; cnt++; }
      atrAvg15[i] = cnt > 0 ? sum / cnt : NaN;
    }
  }
  const atrRel15 = new Float64Array(b15.m).fill(NaN);
  for (let i = 0; i < b15.m; i++) if (atrAvg15[i] > 0 && Number.isFinite(atr15[i])) atrRel15[i] = atr15[i] / atrAvg15[i];
  // ── session VWAP plane (UTC-day anchored) + session age, on the 15m grid ──
  // Cumulative Σ(typical×vol)/Σvol from the UTC day's first bucket; a bucket's
  // VWAP uses only buckets up to and including itself, so a signal read at the
  // completed bucket b never sees future volume. sessAge15 = minutes elapsed in
  // the UTC session at the bucket's close (the desk only trusts the VWAP after
  // the session is at least an hour old).
  const vwap15 = new Float64Array(b15.m).fill(NaN);
  const sessAge15 = new Float64Array(b15.m).fill(NaN);
  {
    let sDay = -1, sPV = 0, sVV = 0;
    for (let i = 0; i < b15.m; i++) {
      const dk = Math.floor(b15.t[i] / 86400e3);
      if (dk !== sDay) { sDay = dk; sPV = 0; sVV = 0; }
      const typ = (b15.h[i] + b15.l[i] + b15.c[i]) / 3;
      sPV += typ * b15.v[i]; sVV += b15.v[i];
      vwap15[i] = sVV > 0 ? sPV / sVV : b15.c[i];
      sessAge15[i] = (b15.t[i] + 900e3 - dk * 86400e3) / 60000; // minutes at bucket close
    }
  }
  // ── round-10 breakout planes: rolling high of the last 48/96 COMPLETED 15m
  // buckets (12h / 24h), inclusive of the read bucket — a signal at minute k
  // only ever sees buckets <= i15[k], the last one fully closed.
  const rollMaxIncl = (arr, period) => {
    const m = arr.length;
    const out = new Float64Array(m).fill(NaN);
    const dq = new Int32Array(m);
    let head = 0, tail = 0;
    for (let i = 0; i < m; i++) {
      while (tail > head && arr[dq[tail - 1]] <= arr[i]) tail--;
      dq[tail++] = i;
      if (dq[head] < i - period + 1) head++;
      if (i >= period - 1) out[i] = arr[dq[head]];
    }
    return out;
  };
  const hi48 = rollMaxIncl(b15.h, 48);
  const hi96 = rollMaxIncl(b15.h, 96);

  // ── round-11 opening-range tables ──
  // Per anchor (00:00 UTC / 13:30 UTC) and window (15/30m), ONE frozen
  // high/low per anchor-day, stamped when the window completes; NaN before
  // completion, for partial windows (data gap / tape start), and for anchors
  // skipped by full-day gaps (placeholder rows keep the day arithmetic true).
  // Built only when the S11 battery is selected (memory note in the header).
  const needOrb = !CFG.only || CFG.only.includes('S11');
  const orbH = [null, null, null, null];
  const orbL = [null, null, null, null];
  const orbBase = [NaN, NaN];
  if (needOrb) {
    for (let ai = 0; ai < 2; ai++) {
      const aOff = ai === 0 ? 0 : 13.5 * 3600e3;
      for (let wi = 0; wi < 2; wi++) {
        const wMin = wi === 0 ? 15 : 30;
        const hs = [], ls = [];
        let curAnchor = NaN, runIdx = -1, hi = -Infinity, lo = Infinity, cnt = 0, done = false, dead = false;
        for (let i = 0; i < n; i++) {
          const anchorT = Math.floor((time[i] - aOff) / 86400e3) * 86400e3 + aOff;
          if (anchorT !== curAnchor) {
            const step = Number.isFinite(curAnchor) ? Math.max(1, Math.round((anchorT - curAnchor) / 86400e3)) : 1;
            for (let z = 0; z < step; z++) { hs.push(NaN); ls.push(NaN); }
            runIdx += step;
            curAnchor = anchorT; hi = -Infinity; lo = Infinity; cnt = 0; done = false; dead = false;
            if (!Number.isFinite(orbBase[ai])) orbBase[ai] = anchorT;
          }
          if (time[i] < anchorT + wMin * 60000) {
            cnt++;
            if (h[i] > hi) hi = h[i];
            if (l[i] < lo) lo = l[i];
          } else if (!done && !dead) {
            if (cnt >= wMin) { done = true; hs[runIdx] = hi; ls[runIdx] = lo; } else dead = true;
          }
        }
        orbH[ai * 2 + wi] = Float64Array.from(hs);
        orbL[ai * 2 + wi] = Float64Array.from(ls);
      }
    }
  }

  // ── 5m grid ──
  const b5 = foldBuckets(time, o, h, l, c, v, 300e3);
  const i5 = lastDoneMap(b5.ord, b5.complete, b5.m);
  const rsi2_5 = rsiSeries(b5.c, 2);
  const atr5 = atrSeries(b5.h, b5.l, b5.c, 14);
  const volAvg5 = smaSeries(b5.v, 20);
  const range5 = new Float64Array(b5.m);
  for (let i = 0; i < b5.m; i++) range5[i] = b5.h[i] - b5.l[i];

  // ── 1h grid ──
  const b1h = foldBuckets(time, o, h, l, c, v, 3600e3);
  const i1h = lastDoneMap(b1h.ord, b1h.complete, b1h.m);
  const ema20h = emaSeries(b1h.c, 20);
  const ema50h = emaSeries(b1h.c, 50);
  const ema100h = emaSeries(b1h.c, 100);
  const slope50h = new Float64Array(b1h.m).fill(0);
  for (let i = 1; i < b1h.m; i++) {
    if (Number.isFinite(ema50h[i]) && Number.isFinite(ema50h[i - 1]) && ema50h[i - 1] > 0) {
      slope50h[i] = (ema50h[i] / ema50h[i - 1] - 1) * 100;
    }
  }

  // ── 4h grid (per-symbol structure gate) ──
  const b4h = foldBuckets(time, o, h, l, c, v, 14400e3);
  const i4h = lastDoneMap(b4h.ord, b4h.complete, b4h.m);
  const ema20_4h = emaSeries(b4h.c, 20);
  const slope20_4h = new Float64Array(b4h.m);
  for (let i = 1; i < b4h.m; i++) {
    if (Number.isFinite(ema20_4h[i]) && Number.isFinite(ema20_4h[i - 1]) && ema20_4h[i - 1] > 0) {
      slope20_4h[i] = (ema20_4h[i] / ema20_4h[i - 1] - 1) * 100;
    }
  }

  // ── 1m auxiliaries ──
  const rollMax60 = new Float64Array(n).fill(NaN);
  const rollMin20 = new Float64Array(n).fill(NaN);
  const vAvg20 = smaSeries(v, 20);
  for (let i = 0; i < n; i++) {
    if (i >= 60) { let mx = -Infinity; for (let j = i - 60; j < i; j++) if (h[j] > mx) mx = h[j]; rollMax60[i] = mx; }
    if (i >= 20) { let mn = Infinity; for (let j = i - 20; j < i; j++) if (l[j] < mn) mn = l[j]; rollMin20[i] = mn; }
  }
  let rollMax120 = null, rollMax30 = null;
  rollMax30 = new Float64Array(n).fill(NaN);
  rollMax120 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i >= 30) { let mx = -Infinity; for (let j = i - 30; j < i; j++) if (h[j] > mx) mx = h[j]; rollMax30[i] = mx; }
    if (i >= 120) { let mx = -Infinity; for (let j = i - 120; j < i; j++) if (h[j] > mx) mx = h[j]; rollMax120[i] = mx; }
  }

  // ── daily context: VWAP, prior-day levels, day low so far ──
  const vwap = new Float64Array(n).fill(NaN);
  const dayLow = new Float64Array(n).fill(NaN);
  const pdl = new Float64Array(n).fill(NaN);
  const pdc = new Float64Array(n).fill(NaN);
  let dayKey = -1, su = 0, sv = 0, dl = Infinity;
  let prevLow = NaN, prevClose = NaN, curLow = Infinity, curClose = NaN;
  for (let i = 0; i < n; i++) {
    const dk = Math.floor(time[i] / 86400e3);
    if (dk !== dayKey) {
      if (dayKey >= 0) { prevLow = curLow; prevClose = curClose; }
      dayKey = dk; su = 0; sv = 0; dl = Infinity; curLow = Infinity;
    }
    const typical = (h[i] + l[i] + c[i]) / 3;
    su += typical * v[i]; sv += v[i];
    vwap[i] = sv > 0 ? su / sv : c[i];
    if (l[i] < dl) dl = l[i];
    dayLow[i] = dl;
    pdl[i] = prevLow; pdc[i] = prevClose;
    if (l[i] < curLow) curLow = l[i];
    curClose = c[i];
  }
  // VWAP stretch: rolling 60m stdev of (close/vwap - 1)
  const rel = new Float64Array(n);
  for (let i = 0; i < n; i++) rel[i] = vwap[i] > 0 ? c[i] / vwap[i] - 1 : 0;
  const vwapDev = stdSeries(rel, 60);
  // ── round-14: US-session open price — the open of the first tape bar at or
  // after 13:30 UTC of the current day; NaN before it (a partial or missing
  // session can't anchor, so no signal fires that day).
  const usOpenPx = new Float64Array(n).fill(NaN);
  {
    let aDay = -1, ax = NaN;
    for (let i = 0; i < n; i++) {
      const dk = Math.floor(time[i] / 86400e3);
      const md = (time[i] % 86400e3) / 60000;
      if (dk !== aDay) { aDay = dk; ax = NaN; }
      if (!Number.isFinite(ax) && md >= 810) ax = o[i];
      usOpenPx[i] = ax;
    }
  }

  return {
    symbol, n, time, o, h, l, c, v, evalStart,
    i15, rsi2_15, rsi14_15, sma5_15, sma20_15, std20_15, ema9_15, ema21_15, atr15, volAvg15, range15, atrRel15, vwap15, sessAge15, hi48, hi96, orbH, orbL, orbBase, h15: b15.h, l15: b15.l, c15: b15.c, v15: b15.v, m15: b15.m,
    i5, rsi2_5, atr5, volAvg5, range5, h5: b5.h, l5: b5.l, c5: b5.c, v5: b5.v, m5: b5.m,
    i1h, ema20h, ema50h, ema100h, slope50h, c1h: b1h.c, m1h: b1h.m,
    i4h, ema20_4h, slope20_4h, c4h: b4h.c,
    rollMax60, rollMax30, rollMax120, rollMin20, vAvg20,
    vwap, vwapDev, dayLow, pdl, pdc, usOpenPx,
    threatBlock: null,   // filled after BTC/ETH context is known
    btcUp: null,         // filled after BTC context is known (1h regime)
    btcD10: null,        // filled after BTC context is known (daily regime)
    btcD10r: null,       // daily regime + SMA10 rising (round-6)
    btcD10p: null,       // daily regime + held above SMA10 4/5 days (round-6)
    btc4hUp: null,       // BTC 4H close>EMA20 & EMA20 rising (round-21)
    btc4hDn: null,       // BTC 4H clearly down: close<EMA20 & EMA20 falling (round-21)
  };
}

// ── MARKET CONTEXT (BTC regime + kingdom threat mapped onto every symbol) ─────
function attachContext(prepared, bySymbol) {
  const btc = bySymbol.get('BTC-USDT');
  const eth = bySymbol.get('ETH-USDT');
  if (!btc) return;
  // round-19 relative-strength plane: BTC's own 1m close by timestamp, so a
  // symbol's trailing return can be compared to the king's over the SAME minutes.
  const btcCloseByT = new Map();
  for (let i = 0; i < btc.n; i++) btcCloseByT.set(btc.time[i], btc.c[i]);
  // round-21 BTC medium-term (4H) regime, read from the last COMPLETED 4H bucket
  const btc4hUpByT = new Map();
  const btc4hDnByT = new Map();
  for (let i = 0; i < btc.n; i++) {
    const h4 = btc.i4h[i];
    if (h4 >= 20 && Number.isFinite(btc.ema20_4h[h4]) && Number.isFinite(btc.slope20_4h[h4])) {
      const up = btc.c4h[h4] > btc.ema20_4h[h4] && btc.slope20_4h[h4] > 0;
      const dn = btc.c4h[h4] < btc.ema20_4h[h4] && btc.slope20_4h[h4] < 0;
      btc4hUpByT.set(btc.time[i], up ? 1 : 0);
      btc4hDnByT.set(btc.time[i], dn ? 1 : 0);
    }
  }
  // BTC 1h uptrend: last completed 1h close > EMA100 and EMA50 slope > 0
  const btcUpByT = new Map();
  const btcThreatByT = new Map();
  const threatByT = new Map();
  for (let i = 0; i < btc.n; i++) {
    const t = btc.time[i];
    const hi = btc.i1h[i];
    if (hi > 0 && Number.isFinite(btc.ema100h[hi]) && btc.slope50h[hi] !== 0) {
      btcUpByT.set(t, (btc.c1h[hi] > btc.ema100h[hi] && btc.slope50h[hi] > 0) ? 1 : 0);
    }
    const j = i >= 1440 ? i - 1440 : -1;
    const bchg = j >= 0 && btc.c[j] > 0 ? (btc.c[i] / btc.c[j] - 1) * 100 : NaN;
    threatByT.set(t, { bchg, echg: NaN });
  }
  // Simplest robust mapping: build eth chg24 by time too.
  if (eth) {
    const ethChg = new Map();
    for (let i = eth.n; i-- > 0;) {
      const j = i >= 1440 ? i - 1440 : -1;
      if (j >= 0 && eth.c[j] > 0) ethChg.set(eth.time[i], (eth.c[i] / eth.c[j] - 1) * 100);
    }
    for (const [t, rec] of threatByT) rec.echg = ethChg.get(t) ?? NaN;
  }

  // BTC daily regime gates, all read from the last COMPLETED UTC day only:
  //   btcD10  close > SMA10 of completed daily closes (SMA10 fits the 12d warmup)
  //   btcD10r btcD10 + the SMA10 itself rising (vs 3 completed days ago) —
  //           kills dead-cat single-day closes above a falling average
  //   btcD10p btcD10 + held above the SMA10 on >=4 of the last 5 completed days
  const b1d = foldBuckets(btc.time, btc.o, btc.h, btc.l, btc.c, btc.v, 86400e3);
  const i1d = lastDoneMap(b1d.ord, b1d.complete, b1d.m);
  const sma10d = smaSeries(b1d.c, 10);
  const btcD10ByT = new Map();
  const btcD10rByT = new Map();
  const btcD10pByT = new Map();
  for (let i = 0; i < btc.n; i++) {
    const bd = i1d[i];
    const ok = bd >= 0 && Number.isFinite(sma10d[bd]) && b1d.c[bd] > sma10d[bd];
    btcD10ByT.set(btc.time[i], ok ? 1 : 0);
    btcD10rByT.set(btc.time[i],
      ok && bd >= 3 && Number.isFinite(sma10d[bd - 3]) && sma10d[bd] > sma10d[bd - 3] ? 1 : 0);
    let persist = 0;
    if (ok && bd >= 13) {
      let held = 0;
      for (let j = bd - 4; j <= bd; j++) if (b1d.c[j] > sma10d[j]) held++;
      persist = held >= 4 ? 1 : 0;
    }
    btcD10pByT.set(btc.time[i], persist);
  }

  for (const p of prepared) {
    p.btcUp = new Uint8Array(p.n);
    p.btcD10 = new Uint8Array(p.n);
    p.btcD10r = new Uint8Array(p.n);
    p.btcD10p = new Uint8Array(p.n);
    p.threatBlock = new Uint8Array(p.n);
    p.btcC = new Float64Array(p.n).fill(NaN);
    p.btc4hUp = new Uint8Array(p.n);
    p.btc4hDn = new Uint8Array(p.n);
    for (let i = 0; i < p.n; i++) {
      const t = p.time[i];
      p.btcUp[i] = btcUpByT.get(t) ?? 0;
      p.btc4hUp[i] = btc4hUpByT.get(t) ?? 0;
      p.btc4hDn[i] = btc4hDnByT.get(t) ?? 0;
      p.btcD10[i] = btcD10ByT.get(t) ?? 0;
      p.btcD10r[i] = btcD10rByT.get(t) ?? 0;
      p.btcD10p[i] = btcD10pByT.get(t) ?? 0;
      p.btcC[i] = btcCloseByT.get(t) ?? NaN;
      const rec = threatByT.get(t);
      if (!rec || !Number.isFinite(rec.bchg)) continue;
      const cat = rec.bchg < -3 || (Number.isFinite(rec.echg) && rec.echg < -5);
      const war = rec.bchg < -1.5 || (Number.isFinite(rec.echg) && rec.echg < -2);
      p.threatBlock[i] = cat || war ? 1 : 0;
    }
  }
}

// ── STRATEGY VARIANTS ─────────────────────────────────────────────────────────
// Each variant: { id, family, label, signal(p, k) -> plan | null }
// plan = { stopDist, targetDist (<=0 or Infinity = dynamic only), dyn(p,i)->bool,
//          eod: bool, timeStopMin }
// All prices are distances from the actual fill (rebased by the simulator), so
// no plan can leak the signal-bar close into the fill level.

const H = 60;
const variants = [];
const add = (v) => { if (!CFG.only || CFG.only.includes(v.family)) variants.push(v); };

function trendUpAt(p, k) {
  const hi = p.i1h[k];
  if (hi < 100) return false;
  return Number.isFinite(p.ema100h[hi]) && p.c1h[hi] > p.ema100h[hi] && p.slope50h[hi] > 0;
}
/** Per-symbol 4H structure: last completed 4H close above its EMA20, rising. */
function sym4hUpAt(p, k) {
  const h4 = p.i4h[k];
  if (h4 < 20) return false;
  return Number.isFinite(p.ema20_4h[h4]) && p.c4h[h4] > p.ema20_4h[h4] && p.slope20_4h[h4] > 0;
}
const has15 = (p, k) => p.i15[k] >= 14;

// ── S1: 15m RSI(2) capitulation buy ──
for (const rsiTh of [10, 20, 30]) {
  for (const stopMult of [1.5, 2.5]) {
    for (const exit of ['sma5', 'r70', '2R', '3R']) {
      for (const trend of ['up', 'off']) {
        add({
          id: `S1_${rsiTh}_${stopMult}_${exit}_${trend}`, family: 'S1',
          label: `MR15-RSI2<${rsiTh} stop${stopMult}xATR ${exit} trend:${trend}`,
          signal: (p, k) => {
            if (!has15(p, k)) return null;
            const b = p.i15[k];
            if (!(p.rsi2_15[b] < rsiTh)) return null;
            if (trend === 'up' && !trendUpAt(p, k)) return null;
            const atr = p.atr15[b];
            if (!(atr > 0)) return null;
            const stopDist = stopMult * atr;
            const dyn = exit === 'sma5' ? (q, i) => {
              const qb = q.i15[i]; if (qb < 0 || qb === b) return false;
              return Number.isFinite(q.sma5_15[qb]) && q.c15[qb] > q.sma5_15[qb];
            } : exit === 'r70' ? (q, i) => {
              const qb = q.i15[i]; if (qb < 0 || qb === b) return false;
              return q.rsi2_15[qb] > 70;
            } : null;
            return {
              stopDist,
              targetDist: exit === '2R' ? 2 * stopDist : exit === '3R' ? 3 * stopDist : Infinity,
              dyn, eod: false, timeStopMin: 8 * H,
            };
          },
        });
      }
    }
  }
}

// ── S2: 15m lower-Bollinger reversion ──
for (const stopMult of [1.5, 2.5]) {
  for (const exit of ['mid', '2R']) {
    for (const trend of ['up', 'off']) {
      add({
        id: `S2_${stopMult}_${exit}_${trend}`, family: 'S2',
        label: `MR15-BB stop${stopMult}xATR ${exit} trend:${trend}`,
        signal: (p, k) => {
          if (!has15(p, k)) return null;
          const b = p.i15[k];
          if (!Number.isFinite(p.sma20_15[b]) || !Number.isFinite(p.std20_15[b])) return null;
          const lower = p.sma20_15[b] - 2 * p.std20_15[b];
          if (!(p.c15[b] < lower)) return null;
          if (trend === 'up' && !trendUpAt(p, k)) return null;
          const atr = p.atr15[b];
          if (!(atr > 0)) return null;
          const stopDist = stopMult * atr;
          const dyn = exit === 'mid' ? (q, i) => {
            const qb = q.i15[i]; if (qb < 0 || qb === b) return false;
            return Number.isFinite(q.sma20_15[qb]) && q.c15[qb] > q.sma20_15[qb];
          } : null;
          return {
            stopDist,
            targetDist: exit === '2R' ? 2 * stopDist : Infinity,
            dyn, eod: false, timeStopMin: 8 * H,
          };
        },
      });
    }
  }
}

// ── S3: VWAP reversion ──
for (const band of [1.5, 2.5]) {
  for (const stopMult of [1.5, 2.5]) {
    for (const trend of ['up', 'off']) {
      add({
        id: `S3_${band}_${stopMult}_${trend}`, family: 'S3',
        label: `VWAP-REV b${band}s stop${stopMult}xATR trend:${trend}`,
        signal: (p, k) => {
          if (!has15(p, k) || !Number.isFinite(p.vwapDev[k]) || p.vwapDev[k] <= 0) return null;
          const stretch = (p.vwap[k] - p.c[k]) / p.vwap[k];
          if (!(stretch >= band * p.vwapDev[k])) return null;
          if (trend === 'up' && !trendUpAt(p, k)) return null;
          const b = p.i15[k];
          const atr = p.atr15[b];
          if (!(atr > 0)) return null;
          const stopDist = stopMult * atr;
          return {
            stopDist, targetDist: Infinity,
            dyn: (q, i) => q.c[i] >= q.vwap[i],
            eod: false, timeStopMin: 8 * H,
          };
        },
      });
    }
  }
}

// ── S4: 1h EMA20 pullback in an uptrend ──
for (const stopMult of [1.2, 2.0]) {
  for (const exit of ['2R', '3R', 'swHi']) {
    for (const timeStopH of [8, 12]) {
      add({
        id: `S4_${stopMult}_${exit}_${timeStopH}`, family: 'S4',
        label: `EMA20H-PULL stop${stopMult}xATR ${exit} ts${timeStopH}h`,
        signal: (p, k) => {
          if (!has15(p, k)) return null;
          const hi = p.i1h[k];
          if (hi < 100) return null;
          const ema = p.ema20h[hi];
          if (!Number.isFinite(ema) || !(ema > 0)) return null;
          if (!(p.slope50h[hi] > 0) || !(p.c1h[hi] > p.ema100h[hi])) return null;
          // tag of the 1h EMA20 from above, reclaimed on this bar
          if (!(p.l[k] <= ema * 1.001)) return null;
          if (!(p.c[k] > ema && p.c[k] > p.o[k])) return null;
          if (p.c[k] > ema * 1.02) return null; // already extended
          const b = p.i15[k];
          const atr = p.atr15[b];
          if (!(atr > 0)) return null;
          const stopDist = stopMult * atr;
          const swHi = p.rollMax120[k];
          let targetDist;
          if (exit === 'swHi') {
            if (!Number.isFinite(swHi)) return null;
            targetDist = Math.max(1.2 * stopDist, swHi - p.c[k]);
          } else {
            targetDist = (exit === '2R' ? 2 : 3) * stopDist;
          }
          return { stopDist, targetDist, dyn: null, eod: false, timeStopMin: timeStopH * H };
        },
      });
    }
  }
}

// ── S5: donchian breakout + volume surge (trend-aligned) ──
for (const win of [30, 60, 120]) {
  for (const volF of ['on', 'off']) {
    for (const exit of ['2R', '3R']) {
      add({
        id: `S5_${win}_${volF}_${exit}`, family: 'S5',
        label: `DONCH-BO ${win}m vol:${volF} ${exit}`,
        signal: (p, k) => {
          if (!has15(p, k)) return null;
          const hi = p.i1h[k];
          if (hi < 100 || !(p.slope50h[hi] > 0) || !(p.c1h[hi] > p.ema50h[hi])) return null;
          const brk = win === 30 ? p.rollMax30[k] : win === 60 ? p.rollMax60[k] : p.rollMax120[k];
          if (!Number.isFinite(brk)) return null;
          if (!(p.c[k] >= brk)) return null;
          if (volF === 'on') {
            if (!(Number.isFinite(p.vAvg20[k]) && p.vAvg20[k] > 0)) return null;
            if (!(p.v[k] >= 1.5 * p.vAvg20[k])) return null;
          }
          // Not extended: within 2 x ATR15 of the 1h EMA20
          const ema = p.ema20h[hi];
          const b = p.i15[k];
          const atr = p.atr15[b];
          if (!(atr > 0) || !Number.isFinite(ema)) return null;
          if (p.c[k] - ema > 2.0 * atr) return null;
          const stopDist = 1.2 * atr;
          return { stopDist, targetDist: (exit === '2R' ? 2 : 3) * stopDist, dyn: null, eod: false, timeStopMin: 8 * H };
        },
      });
    }
  }
}

// ── S6: prior-day-low sweep + reclaim ──
for (const depth of [0.001, 0.003]) {
  for (const exit of ['pdc', '2R', '3R']) {
    add({
      id: `S6_${depth}_${exit}`, family: 'S6',
      label: `PDL-SWEEP d${(depth * 100).toFixed(1)}% ${exit}`,
      signal: (p, k) => {
        if (!has15(p, k)) return null;
        const pl = p.pdl[k];
        if (!Number.isFinite(pl) || !(pl > 0)) return null;
        const mod = (p.time[k] % 86400e3) / 60000; // minute of UTC day
        if (mod < 120 || mod > 1320) return null;
        // the day swept the prior low beyond `depth`...
        if (!(p.dayLow[k] < pl * (1 - depth))) return null;
        // ...and price has reclaimed the level from below, close to it
        if (!(p.c[k] > pl && p.c[k] < pl * 1.01)) return null;
        if (!(p.c[k] > p.o[k])) return null;
        const b = p.i15[k];
        const atr = p.atr15[b];
        if (!(atr > 0)) return null;
        let stopDist = p.c[k] - (p.dayLow[k] - 0.25 * atr);
        if (!(stopDist > 0)) return null;
        if (stopDist > 2.5 * atr) return null; // sweep too deep — invalidated structure
        let targetDist;
        if (exit === 'pdc') {
          const pdc = p.pdc[k];
          if (!Number.isFinite(pdc) || pdc - p.c[k] < 1.2 * stopDist) return null;
          targetDist = pdc - p.c[k];
        } else {
          targetDist = (exit === '2R' ? 2 : 3) * stopDist;
        }
        return { stopDist, targetDist, dyn: null, eod: true, timeStopMin: 24 * H };
      },
    });
  }
}

// ── S7: NR7 compression breakout on the 15m grid ──
for (const volF of ['on', 'off']) {
  for (const exit of ['2R', '3R']) {
    add({
      id: `S7_${volF}_${exit}`, family: 'S7',
      label: `NR7-SQ vol:${volF} ${exit}`,
      signal: (p, k) => {
        if (!has15(p, k) || p.i15[k] < 7) return null;
        const nb = p.i15[k]; // the just-completed bar
        // narrowest range of the last 7 completed bars
        const r = p.range15[nb];
        if (!(r > 0)) return null;
        for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
        // fresh break of the narrow bar's high
        const lvl = p.h15[nb];
        if (!(p.c[k] > lvl)) return null;
        if (!(p.c[k] <= lvl * 1.004)) return null;
        if (volF === 'on') {
          if (!(p.volAvg15[nb] > 0)) return null;
          if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
        }
        const atr = p.atr15[nb];
        if (!(atr > 0)) return null;
        let stopDist = p.c[k] - p.l15[nb];
        stopDist = clampi(stopDist, 1.0 * atr, 2.5 * atr);
        return { stopDist, targetDist: (exit === '2R' ? 2 : 3) * stopDist, dyn: null, eod: false, timeStopMin: 8 * H };
      },
    });
  }
}

// ── S1R: RSI2 capitulation, round 2 ───────────────────────────────────────────
// The run-1 winner family refined: deeper thresholds, climax-volume filter,
// ATR%-of-price floor (kills dead-vol symbols whose stops are pure noise),
// structural exits (fixed 3R vs 3R-with-trail vs pure trail) and a post-stop
// per-symbol cooldown. Trend gate stays ALWAYS on — it was half the edge.
for (const rsiTh of [3, 10]) {
  for (const exit of ['3R', '3R_trail', 'trail']) {
    for (const climax of ['off', 'on']) {
      for (const atrPctFloor of [0, 0.002]) {
        for (const cdMin of [0, 180]) {
          add({
            id: `S1R_${rsiTh}_${exit}_${climax}_${atrPctFloor}_${cdMin}`, family: 'S1R',
            label: `RSI2v2<${rsiTh} ${exit} climax:${climax} atr%:${atrPctFloor} cd:${cdMin}`,
            cdMin,
            signal: (p, k) => {
              if (!has15(p, k)) return null;
              const b = p.i15[k];
              if (!(p.rsi2_15[b] < rsiTh)) return null;
              if (!trendUpAt(p, k)) return null;
              const atr = p.atr15[b];
              if (!(atr > 0)) return null;
              if (atrPctFloor > 0 && !(atr / p.c[k] >= atrPctFloor)) return null;
              if (climax === 'on') {
                if (!(p.volAvg15[b] > 0)) return null;
                if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
              }
              const stopDist = 2.5 * atr;
              const targetDist = exit === 'trail' ? Infinity : 3 * stopDist;
              const trailDist = exit === 'trail' || exit === '3R_trail' ? 2.0 * atr : 0;
              return {
                stopDist, targetDist, dyn: null, eod: false, timeStopMin: 8 * H,
                trailDist, armR: 1, priority: p.rsi2_15[b],
              };
            },
          });
        }
      }
    }
  }
}

// ── S3R: VWAP reversion, round 2 ──────────────────────────────────────────────
// Run-1 S3 won 61.8% of its trades yet bled — wins were capped by the VWAP
// touch while losses ran wide. Round 2 keeps the 2.5σ stretch + uptrend gate
// but sizes every stop, and the two "cap" exits take whichever comes first:
// the R-capped target or the VWAP touch. priority = most stretched first.
for (const stopMult of [1.2, 1.5, 2.0]) {
  for (const exit of ['vwapCap1.5R', 'vwapCap2R', 'fixed2R']) {
    for (const btcGate of ['off', 'on']) {
      add({
        id: `S3R_${stopMult}_${exit}_${btcGate}`, family: 'S3R',
        label: `VWAPv2 s${stopMult} ${exit} btc:${btcGate}`,
        signal: (p, k) => {
          if (!has15(p, k) || !Number.isFinite(p.vwapDev[k]) || p.vwapDev[k] <= 0) return null;
          const stretch = (p.vwap[k] - p.c[k]) / p.vwap[k];
          if (!(stretch >= 2.5 * p.vwapDev[k])) return null;
          if (!trendUpAt(p, k)) return null;
          if (btcGate === 'on' && !p.btcUp[k]) return null;
          const b = p.i15[k];
          const atr = p.atr15[b];
          if (!(atr > 0)) return null;
          const stopDist = stopMult * atr;
          const cap = exit === 'vwapCap1.5R' ? 1.5 : exit === 'vwapCap2R' ? 2 : null;
          return {
            stopDist,
            targetDist: cap ? cap * stopDist : 2 * stopDist,
            dyn: cap ? (q, i) => q.c[i] >= q.vwap[i] : null,
            eod: false, timeStopMin: 4 * H,
            priority: -stretch,
          };
        },
      });
    }
  }
}

// ── S6R: PDL sweep, round 2 ───────────────────────────────────────────────────
// Run-1 S6 lost mainly on deep sweeps that kept going. Round 2 keeps the
// reclaim mechanics but rejects stops wider than 1.5 x ATR, demands a 1h
// uptrend, and floors the stop at 0.3 x ATR so it is never hug-tight.
for (const depth of [0.001, 0.003]) {
  for (const exit of ['1.5R', '2R']) {
    add({
      id: `S6R_${depth}_${exit}`, family: 'S6R',
      label: `PDLv2 d${(depth * 100).toFixed(1)}% ${exit}`,
      signal: (p, k) => {
        if (!has15(p, k)) return null;
        const pl = p.pdl[k];
        if (!Number.isFinite(pl) || !(pl > 0)) return null;
        const mod = (p.time[k] % 86400e3) / 60000;
        if (mod < 120 || mod > 1320) return null;
        if (!(p.dayLow[k] < pl * (1 - depth))) return null;
        if (!(p.c[k] > pl && p.c[k] < pl * 1.01)) return null;
        if (!(p.c[k] > p.o[k])) return null;
        if (!trendUpAt(p, k)) return null;
        const b = p.i15[k];
        const atr = p.atr15[b];
        if (!(atr > 0)) return null;
        const stopDist = p.c[k] - (p.dayLow[k] - 0.25 * atr);
        if (!(stopDist > 0.3 * atr)) return null;
        if (stopDist > 1.5 * atr) return null;
        return { stopDist, targetDist: (exit === '1.5R' ? 1.5 : 2) * stopDist, dyn: null, eod: true, timeStopMin: 24 * H };
      },
    });
  }
}

// ── S7R: NR7 compression breakout, round 2 ────────────────────────────────────
// Run-1 S7 was the only other family near break-even. Volume surge is now a
// hard requirement; the stop floor widens so the break has room, and the
// trail exit lets a real expansion leg run past the 3R cap.
for (const stopFloor of [1.0, 1.5]) {
  for (const exit of ['3R', 'trail']) {
    add({
      id: `S7R_${stopFloor}_${exit}`, family: 'S7R',
      label: `NR7v2 f${stopFloor} ${exit}`,
      signal: (p, k) => {
        if (!has15(p, k) || p.i15[k] < 7) return null;
        const nb = p.i15[k];
        const r = p.range15[nb];
        if (!(r > 0)) return null;
        for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
        const lvl = p.h15[nb];
        if (!(p.c[k] > lvl)) return null;
        if (!(p.c[k] <= lvl * 1.004)) return null;
        if (!(p.volAvg15[nb] > 0)) return null;
        if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
        const atr = p.atr15[nb];
        if (!(atr > 0)) return null;
        let stopDist = p.c[k] - p.l15[nb];
        stopDist = clampi(stopDist, stopFloor * atr, 2.5 * atr);
        return {
          stopDist,
          targetDist: exit === 'trail' ? Infinity : 3 * stopDist,
          dyn: null, eod: false, timeStopMin: 8 * H,
          trailDist: exit === 'trail' ? 1.5 * atr : 0, armR: 1,
        };
      },
    });
  }
}

// ── S7R2: NR7 neighborhood of the portfolio champion (NR7v2 f1.5 3R) ─────────
// Round-3 local sweep: stop floor, R multiple, time stop — everything else
// frozen (volume surge hard-required, reclaim within 0.4% of the level).
for (const stopFloor of [1.25, 1.5, 2.0]) {
  for (const exit of ['2.5R', '3R', '4R']) {
    for (const tsH of [6, 12]) {
      add({
        id: `S7R2_${stopFloor}_${exit}_${tsH}`, family: 'S7R2',
        label: `NR7v3 f${stopFloor} ${exit} ts${tsH}h`,
        signal: (p, k) => {
          if (!has15(p, k) || p.i15[k] < 7) return null;
          const nb = p.i15[k];
          const r = p.range15[nb];
          if (!(r > 0)) return null;
          for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
          const lvl = p.h15[nb];
          if (!(p.c[k] > lvl)) return null;
          if (!(p.c[k] <= lvl * 1.004)) return null;
          if (!(p.volAvg15[nb] > 0)) return null;
          if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
          const atr = p.atr15[nb];
          if (!(atr > 0)) return null;
          let stopDist = p.c[k] - p.l15[nb];
          stopDist = clampi(stopDist, stopFloor * atr, 2.5 * atr);
          const mult = exit === '2.5R' ? 2.5 : exit === '3R' ? 3 : 4;
          return { stopDist, targetDist: mult * stopDist, dyn: null, eod: false, timeStopMin: tsH * H };
        },
      });
    }
  }
}

// ── S1R2: RSI2v3 neighborhood of the portfolio runner-up (trail geometry) ────
// Round-3 local sweep around RSI2v2<3 trail climax:on atr%:0.002 cd:180:
// trail distance, arming threshold, cooldown length. Everything else frozen.
for (const trailMult of [1.5, 2.0, 2.5]) {
  for (const armR of [0.5, 0.75, 1.0]) {
    for (const cdMin of [180, 360]) {
      add({
        id: `S1R2_${trailMult}_${armR}_${cdMin}`, family: 'S1R2',
        label: `RSI2v3 trail${trailMult}x arm${armR} cd${cdMin}`,
        cdMin,
        signal: (p, k) => {
          if (!has15(p, k)) return null;
          const b = p.i15[k];
          if (!(p.rsi2_15[b] < 3)) return null;
          if (!trendUpAt(p, k)) return null;
          const atr = p.atr15[b];
          if (!(atr > 0)) return null;
          if (!(atr / p.c[k] >= 0.002)) return null;
          if (!(p.volAvg15[b] > 0)) return null;
          if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
          const stopDist = 2.5 * atr;
          return {
            stopDist, targetDist: Infinity, dyn: null, eod: false, timeStopMin: 8 * H,
            trailDist: trailMult * atr, armR, priority: p.rsi2_15[b],
          };
        },
      });
    }
  }
}

// ── S7R3: NR7 round-3 winners + BTC regime gates ─────────────────────────────
// The 120d validation exposed the true failure mode: expansion breakouts bleed
// in choppy/bleeding tapes. Gates: btc = BTC 1h uptrend (EMA100 + slope),
// btcD10 = last completed day close above its 10-day SMA (plus the 1h gate).
for (const [f, exit, tsH] of [[2, '4R', 12], [2, '3R', 12], [1.5, '4R', 12]]) {
  for (const gate of ['off', 'btc', 'btcD10']) {
    add({
      id: `S7R3_${f}_${exit}_${tsH}_${gate}`, family: 'S7R3',
      label: `NR7v4 f${f} ${exit} ts${tsH}h gate:${gate}`,
      signal: (p, k) => {
        if (gate === 'btc' && !p.btcUp[k]) return null;
        if (gate === 'btcD10' && !(p.btcUp[k] && p.btcD10[k])) return null;
        if (!has15(p, k) || p.i15[k] < 7) return null;
        const nb = p.i15[k];
        const r = p.range15[nb];
        if (!(r > 0)) return null;
        for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
        const lvl = p.h15[nb];
        if (!(p.c[k] > lvl)) return null;
        if (!(p.c[k] <= lvl * 1.004)) return null;
        if (!(p.volAvg15[nb] > 0)) return null;
        if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
        const atr = p.atr15[nb];
        if (!(atr > 0)) return null;
        let stopDist = p.c[k] - p.l15[nb];
        stopDist = clampi(stopDist, f * atr, 2.5 * atr);
        const mult = exit === '4R' ? 4 : exit === '3R' ? 3 : 2.5;
        return { stopDist, targetDist: mult * stopDist, dyn: null, eod: false, timeStopMin: tsH * H };
      },
    });
  }
}

// ── S1R3: RSI2 round-3 winners + BTC regime gates ────────────────────────────
// Same gate axis on the balanced capitulation geometry (trail 2.5x).
for (const [trailMult, armR, cdMin] of [[2.5, 0.5, 360], [2.5, 0.5, 180], [2.5, 1.0, 180]]) {
  for (const gate of ['off', 'btc', 'btcD10']) {
    add({
      id: `S1R3_${trailMult}_${armR}_${cdMin}_${gate}`, family: 'S1R3',
      label: `RSI2v4 t${trailMult}x a${armR} cd${cdMin} gate:${gate}`,
      cdMin,
      signal: (p, k) => {
        if (gate === 'btc' && !p.btcUp[k]) return null;
        if (gate === 'btcD10' && !(p.btcUp[k] && p.btcD10[k])) return null;
        if (!has15(p, k)) return null;
        const b = p.i15[k];
        if (!(p.rsi2_15[b] < 3)) return null;
        if (!trendUpAt(p, k)) return null;
        const atr = p.atr15[b];
        if (!(atr > 0)) return null;
        if (!(atr / p.c[k] >= 0.002)) return null;
        if (!(p.volAvg15[b] > 0)) return null;
        if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
        const stopDist = 2.5 * atr;
        return {
          stopDist, targetDist: Infinity, dyn: null, eod: false, timeStopMin: 8 * H,
          trailDist: trailMult * atr, armR, priority: p.rsi2_15[b],
        };
      },
    });
  }
}

// ── S7R5: NR7v4 + entry-quality filters (strong close, per-symbol 4H trend) ──
// Failure anatomy: 67% of NR7 trades stopped out — losses concentrate on weak
// breakout bars in symbols whose 4H structure is not up. All variants carry
// the btcD10 gate (best from round 4).
for (const sym4h of ['off', 'on']) {
  for (const strongClose of ['off', 'on']) {
    for (const volMult of [1.5, 2.0]) {
      add({
        id: `S7R5_${sym4h}_${strongClose}_${volMult}`, family: 'S7R5',
        label: `NR7v5 4h:${sym4h} strong:${strongClose} vol${volMult}`,
        signal: (p, k) => {
          if (!(p.btcUp[k] && p.btcD10[k])) return null;
          if (sym4h === 'on' && !sym4hUpAt(p, k)) return null;
          if (!has15(p, k) || p.i15[k] < 7) return null;
          const nb = p.i15[k];
          const r = p.range15[nb];
          if (!(r > 0)) return null;
          for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
          const lvl = p.h15[nb];
          if (!(p.c[k] > lvl)) return null;
          if (!(p.c[k] <= lvl * 1.004)) return null;
          if (strongClose === 'on') {
            const rng = p.h[k] - p.l[k];
            if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
          }
          if (!(p.volAvg15[nb] > 0)) return null;
          if (!(p.v15[nb] >= volMult * p.volAvg15[nb])) return null;
          const atr = p.atr15[nb];
          if (!(atr > 0)) return null;
          let stopDist = p.c[k] - p.l15[nb];
          stopDist = clampi(stopDist, 2.0 * atr, 2.5 * atr);
          return { stopDist, targetDist: 4 * stopDist, dyn: null, eod: false, timeStopMin: 12 * H };
        },
      });
    }
  }
}
// longer leash on the exact gated winner (ts12 -> ts24)
add({
  id: 'S7R5_ts24', family: 'S7R5',
  label: 'NR7v5 winner ts24h',
  signal: (p, k) => {
    if (!(p.btcUp[k] && p.btcD10[k])) return null;
    if (!has15(p, k) || p.i15[k] < 7) return null;
    const nb = p.i15[k];
    const r = p.range15[nb];
    if (!(r > 0)) return null;
    for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
    const lvl = p.h15[nb];
    if (!(p.c[k] > lvl)) return null;
    if (!(p.c[k] <= lvl * 1.004)) return null;
    if (!(p.volAvg15[nb] > 0)) return null;
    if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
    const atr = p.atr15[nb];
    if (!(atr > 0)) return null;
    let stopDist = p.c[k] - p.l15[nb];
    stopDist = clampi(stopDist, 2.0 * atr, 2.5 * atr);
    return { stopDist, targetDist: 4 * stopDist, dyn: null, eod: false, timeStopMin: 24 * H };
  },
});

// ── S1R5: RSI2v4 + per-symbol 4H trend alignment ──
for (const [armR, cdMin] of [[0.5, 180], [1.0, 180]]) {
  for (const sym4h of ['off', 'on']) {
    add({
      id: `S1R5_${armR}_${sym4h}`, family: 'S1R5',
      label: `RSI2v5 a${armR} 4h:${sym4h}`,
      cdMin,
      signal: (p, k) => {
        if (!(p.btcUp[k] && p.btcD10[k])) return null;
        if (sym4h === 'on' && !sym4hUpAt(p, k)) return null;
        if (!has15(p, k)) return null;
        const b = p.i15[k];
        if (!(p.rsi2_15[b] < 3)) return null;
        if (!trendUpAt(p, k)) return null;
        const atr = p.atr15[b];
        if (!(atr > 0)) return null;
        if (!(atr / p.c[k] >= 0.002)) return null;
        if (!(p.volAvg15[b] > 0)) return null;
        if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
        const stopDist = 2.5 * atr;
        return {
          stopDist, targetDist: Infinity, dyn: null, eod: false, timeStopMin: 8 * H,
          trailDist: 2.5 * atr, armR, priority: p.rsi2_15[b],
        };
      },
    });
  }
}

// ── S7R6: NR7v6 — sharpened daily gate (SMA10 rising / persistence) ──────────
// Round-5 anatomy: the residual H1 bleed is dead-cat bounces that close a
// single day above the daily SMA10 while the average itself is still falling.
// d10r additionally demands SMA10(d) > SMA10(d-3); d10p demands the price to
// have held above the SMA10 on >=4 of the last 5 completed days. Geometry is
// frozen at the round-5 winner (sym4h on, strong close on, vol 1.5x, 4R, ts12h).
const gate6 = (p, k, gate) => {
  if (!(p.btcUp[k] && p.btcD10[k])) return false;
  if (gate === 'd10r' && !p.btcD10r[k]) return false;
  if (gate === 'd10p' && !p.btcD10p[k]) return false;
  return true;
};
function nr7v6Signal(p, k, f, exitCfg) {
  if (!has15(p, k) || p.i15[k] < 7) return null;
  const nb = p.i15[k];
  const r = p.range15[nb];
  if (!(r > 0)) return null;
  for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
  const lvl = p.h15[nb];
  if (!(p.c[k] > lvl)) return null;
  if (!(p.c[k] <= lvl * 1.004)) return null;
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
  if (!(p.volAvg15[nb] > 0)) return null;
  if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
  if (!sym4hUpAt(p, k)) return null;
  const atr = p.atr15[nb];
  if (!(atr > 0)) return null;
  const stopDist = clampi(p.c[k] - p.l15[nb], f * atr, 2.5 * atr);
  const plan = { stopDist, targetDist: 4 * stopDist, dyn: null, eod: false, timeStopMin: 12 * H };
  if (exitCfg.trailMult) { plan.trailDist = exitCfg.trailMult * stopDist; plan.armR = exitCfg.armR; }
  return plan;
}
for (const f of [1.5, 2.0]) {
  for (const gate of ['d10', 'd10r', 'd10p']) {
    add({
      id: `S7R6_${f}_${gate}`, family: 'S7R6',
      label: `NR7v6 f${f} gate:${gate} 4R ts12`,
      signal: (p, k) => (gate6(p, k, gate) ? nr7v6Signal(p, k, f, {}) : null),
    });
  }
}
// trail experiments on the d10r gate: protect the give-back after +1R
for (const trailMult of [1.0, 1.5]) {
  add({
    id: `S7R6_t${trailMult}_d10r`, family: 'S7R6',
    label: `NR7v6 f1.5 trail${trailMult}R arm1R gate:d10r`,
    signal: (p, k) => (gate6(p, k, 'd10r') ? nr7v6Signal(p, k, 1.5, { trailMult, armR: 1.0 }) : null),
  });
}

// ── S16: NR7 volume-gate forensics + ablation (round-16) ─────────────────────
// The AXS-class refusal (a +14.8% mover parked at "bucket at 0.54x, need
// >=1.5x" with 8/9 asset gates green) exposed the one NR7 filter never
// re-tested after round 5: the compression-bucket volume requirement. Round 16
// splits the refusal band (forensics) and, separately, re-tries the threshold
// and the volume DEFINITION (ablation). Geometry is otherwise byte-identical
// to the shipped winner S7R6_2_d10 (f2 clamp, strong close >=0.6, sym4h up,
// 4R, ts12h, gate d10) — the SAME gate6 + strong-close + stop-clamp path.
function nr7v6VolSignal(p, k, volOk) {
  if (!has15(p, k) || p.i15[k] < 7) return null;
  const nb = p.i15[k];
  const r = p.range15[nb];
  if (!(r > 0)) return null;
  for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return null;
  const lvl = p.h15[nb];
  if (!(p.c[k] > lvl)) return null;
  if (!(p.c[k] <= lvl * 1.004)) return null;
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
  if (!volOk(p, nb, k)) return null;
  if (!sym4hUpAt(p, k)) return null;
  const atr = p.atr15[nb];
  if (!(atr > 0)) return null;
  const stopDist = clampi(p.c[k] - p.l15[nb], 2.0 * atr, 2.5 * atr);
  return { stopDist, targetDist: 4 * stopDist, dyn: null, eod: false, timeStopMin: 12 * H };
}
const volRatioAt = (p, nb) => (p.volAvg15[nb] > 0 ? p.v15[nb] / p.volAvg15[nb] : NaN);
// FORENSICS (cannot port): tile the pre-wall region; the shipped row is [1.5,inf).
for (const [tag, lo, hi] of [['B0', 0, 0.5], ['B1', 0.5, 1.0], ['B2', 1.0, 1.5]]) {
  add({
    id: `S16_FRN_${tag}`, family: 'S16',
    label: `NR7v6 forensics volRatio[${lo},${hi}) gate:d10`,
    signal: (p, k) => (gate6(p, k, 'd10') ? nr7v6VolSignal(p, k, (q, nb) => {
      const vr = volRatioAt(q, nb);
      return Number.isFinite(vr) && vr >= lo && vr < hi;
    }) : null),
  });
}
// ABLATION (port candidates): relax or drop the bucket-volume wall.
for (const [tag, mult] of [['125', 1.25], ['100', 1.0], ['off', 0]]) {
  add({
    id: `S16_ABL_${tag}`, family: 'S16',
    label: `NR7v6 abl vol>=${mult}x gate:d10`,
    signal: (p, k) => (gate6(p, k, 'd10') ? nr7v6VolSignal(p, k, (q, nb) =>
      (mult === 0 ? true : (q.volAvg15[nb] > 0 && q.v15[nb] >= mult * q.volAvg15[nb]))) : null),
  });
}
// TAPE-IGNITION (port candidates): ignition on the breakout 1m bar vs its own
// 20-bar average; the compression-bucket wall is dropped.
for (const kt of [2, 3]) {
  add({
    id: `S16_TAPE_${kt}`, family: 'S16',
    label: `NR7v6 tape v>=${kt}x vAvg20 gate:d10`,
    signal: (p, k) => (gate6(p, k, 'd10') ? nr7v6VolSignal(p, k, (q, nb, kk) =>
      (Number.isFinite(q.vAvg20[kk]) && q.vAvg20[kk] > 0 && q.v[kk] >= kt * q.vAvg20[kk])) : null),
  });
}

// ── S17: EXPAND — expansion-bar breakout with TAPE ignition (round-17) ───────
// The coverage round. Every momentum family here (S10 rolling-high MOM, S11
// ORB, and the NR7 desk itself) measures ignition on the TRAILING completed
// bucket (v15[b] >= 1.5 x volAvg15[b]). The mover we keep refusing — AXS, 8/9
// asset gates green, refused only at bucket volume 0.54x — is exactly a strong
// breakout TAPE under a quiet prior bucket. Round 17 tests that untested cell.
function expand15Signal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const nb = p.i15[k];
  const atr = p.atr15[nb];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const rng15 = p.h15[nb] - p.l15[nb];
  if (!(rng15 >= cfg.kExp * atr)) return null;            // wide-range expansion bar
  const lvl = p.h15[nb];
  if (!(p.c[k] > lvl)) return null;                       // 1m close breaks its high
  if (!(p.c[k] <= lvl * (1 + cfg.leash))) return null;    // within the leash
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null; // strong breakout bar
  if (cfg.vol === 'tape') {
    if (!(Number.isFinite(p.vAvg20[k]) && p.vAvg20[k] > 0)) return null;
    if (!(p.v[k] >= cfg.kT * p.vAvg20[k])) return null;
  } else if (cfg.vol === 'bucket') {
    if (!(p.volAvg15[nb] > 0)) return null;
    if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return null;
  }
  const stopDist = clampi(p.c[k] - p.l15[nb], 1.5 * atr, 2.5 * atr);
  const plan = {
    stopDist,
    targetDist: cfg.exit === '3R' ? 3 * stopDist : Infinity,
    dyn: null, eod: false, timeStopMin: cfg.tsH * H,
    priority: -rng15 / atr, // strongest expansion trades first in the shared book
  };
  if (cfg.exit === 'trail') { plan.trailDist = 2.5 * atr; plan.armR = 1.0; }
  return plan;
}
function expand5Signal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (p.i5[k] < 14) return null;
  const nb = p.i5[k];
  const atr = p.atr5[nb];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const rng5 = p.range5[nb];
  if (!(rng5 >= cfg.kExp * atr)) return null;             // wide-range expansion bar
  const lvl = p.h5[nb];
  if (!(p.c[k] > lvl)) return null;
  if (!(p.c[k] <= lvl * (1 + cfg.leash))) return null;
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
  if (!(Number.isFinite(p.vAvg20[k]) && p.vAvg20[k] > 0)) return null;
  if (!(p.v[k] >= cfg.kT * p.vAvg20[k])) return null;
  const stopDist = clampi(p.c[k] - p.l5[nb], 1.5 * atr, 2.5 * atr);
  const plan = {
    stopDist,
    targetDist: cfg.exit === '3R' ? 3 * stopDist : Infinity,
    dyn: null, eod: false, timeStopMin: cfg.tsH * H,
    priority: -rng5 / atr,
  };
  if (cfg.exit === 'trail') { plan.trailDist = 2.5 * atr; plan.armR = 1.0; }
  return plan;
}
for (const kExp of [1.25, 1.5]) {
  for (const [ltag, leash] of [['l04', 0.004], ['l10', 0.010]]) {
    for (const kT of [2, 3]) {
      for (const exit of ['3R', 'trail']) {
        const cfg = { kExp, leash, kT, exit, tsH: 12, vol: 'tape' };
        add({
          id: `S17_EXP_${kExp}_${ltag}_k${kT}_${exit}`, family: 'S17',
          label: `EXPAND-15 k${kExp} ${ltag} tape${kT} ${exit}`,
          cdMin: 240,
          signal: (p, k) => (gate6(p, k, 'd10') ? expand15Signal(p, k, cfg) : null),
        });
      }
    }
  }
}
for (const kExp of [1.25, 1.5]) {
  for (const kT of [2, 3]) {
    for (const exit of ['3R', 'trail']) {
      const cfg = { kExp, leash: 0.006, kT, exit, tsH: 4 };
      add({
        id: `S17_EXP5_${kExp}_k${kT}_${exit}`, family: 'S17',
        label: `EXPAND-5 k${kExp} tape${kT} ${exit}`,
        cdMin: 120,
        signal: (p, k) => (gate6(p, k, 'd10') ? expand5Signal(p, k, cfg) : null),
      });
    }
  }
}
// DEF controls (definition question) + gate-off (mechanism reading only)
add({
  id: 'S17_DEF_bucketvol', family: 'S17',
  label: 'EXPAND-15 k1.25 l04 bucketvol trail',
  cdMin: 240,
  signal: (p, k) => (gate6(p, k, 'd10')
    ? expand15Signal(p, k, { kExp: 1.25, leash: 0.004, exit: 'trail', tsH: 12, vol: 'bucket' }) : null),
});
add({
  id: 'S17_DEF_novol', family: 'S17',
  label: 'EXPAND-15 k1.25 l04 novol trail',
  cdMin: 240,
  signal: (p, k) => (gate6(p, k, 'd10')
    ? expand15Signal(p, k, { kExp: 1.25, leash: 0.004, exit: 'trail', tsH: 12, vol: 'off' }) : null),
});
add({
  id: 'S17_gateoff', family: 'S17',
  label: 'EXPAND-15 k1.25 l04 tape3 trail gate:off',
  cdMin: 240,
  signal: (p, k) => expand15Signal(p, k, { kExp: 1.25, leash: 0.004, kT: 3, exit: 'trail', tsH: 12, vol: 'tape' }),
});

// ── S18: RETEST — break-and-retest continuation on the 15m grid ──────────────
// The classical second chance after a breakout: a prior 15m swing high that has
// been broken, then defended on the pullback. Distinct from the NR7 breakout
// (which enters the break of the JUST-completed bucket) — here the level is an
// OLDER swing high (rb buckets back) and the entry is the 1m bar that dips to it
// and closes back above it. Round-16 refused the weak-volume break itself; the
// retest is the tape's chance to re-qualify the level.
function retest15Signal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const nb = p.i15[k];
  const A = nb - cfg.rb - 1;                 // the anchor bucket (swing-high candidate)
  if (A < 8) return null;                    // need prior context for the swing test
  const lvl = p.h15[A];
  if (!(lvl > 0)) return null;
  if (cfg.swing) {                           // the level must be a local swing high
    if (!(lvl >= p.h15[A - 1] && lvl >= p.h15[A + 1])) return null;
  }
  // the level was broken by a completed 15m close within the last rb buckets
  let broke = false;
  for (let j = nb - cfg.rb; j <= nb; j++) if (p.c15[j] > lvl) { broke = true; break; }
  if (!broke) return null;
  const atr = p.atr15[nb];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  // the retest-hold bar: this 1m bar dips to the level and reclaims just above it
  if (!(p.l[k] <= lvl * (1 + 0.003))) return null;
  if (!(p.c[k] >= lvl)) return null;
  if (!(p.c[k] <= lvl * (1 + cfg.leash))) return null;
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
  if (!(p.c[k] >= p.o[k])) return null;
  const stopDist = clampi(p.c[k] - Math.min(p.l[k], lvl) + 0.2 * atr, 1.0 * atr, 2.5 * atr);
  const plan = {
    stopDist,
    targetDist: cfg.exit === '3R' ? 3 * stopDist : Infinity,
    dyn: null, eod: false, timeStopMin: 12 * H,
    priority: -Math.abs(p.c[k] - lvl) / atr,   // closest retest trades first
  };
  if (cfg.exit === 'trail') { plan.trailDist = 2.0 * atr; plan.armR = 1.0; }
  return plan;
}
// DEF control: the same older level, but the FIRST break of it (no retest).
function breakEntry15Signal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const nb = p.i15[k];
  const A = nb - cfg.rb - 1;
  if (A < 8) return null;
  const lvl = p.h15[A];
  if (!(lvl > 0)) return null;
  if (!(lvl >= p.h15[A - 1] && lvl >= p.h15[A + 1])) return null;  // swing high
  for (let j = nb - cfg.rb; j <= nb; j++) if (p.c15[j] > lvl) return null; // must be FRESH
  if (!(p.c[k] > lvl)) return null;
  if (!(p.c[k] <= lvl * (1 + cfg.leash))) return null;
  const rng = p.h[k] - p.l[k];
  if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return null;
  const atr = p.atr15[nb];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const stopDist = clampi(p.c[k] - lvl + 0.2 * atr, 1.0 * atr, 2.5 * atr);
  return {
    stopDist, targetDist: 3 * stopDist, dyn: null, eod: false, timeStopMin: 12 * H,
    priority: -Math.abs(p.c[k] - lvl) / atr,
  };
}
for (const rb of [3, 5, 7]) {
  for (const [ltag, leash] of [['l04', 0.004], ['l08', 0.008]]) {
    for (const exit of ['3R', 'trail']) {
      const cfg = { rb, leash, exit, swing: true };
      add({
        id: `S18_RT_${rb}_${ltag}_${exit}`, family: 'S18',
        label: `RETEST rb${rb} ${ltag} ${exit}`,
        cdMin: 240,
        signal: (p, k) => (gate6(p, k, 'd10') ? retest15Signal(p, k, cfg) : null),
      });
    }
  }
}
// DEF controls (definition question) + gate-off (mechanism reading only)
add({
  id: 'S18_DEF_noswing', family: 'S18',
  label: 'RETEST rb3 l04 3R noswing',
  cdMin: 240,
  signal: (p, k) => (gate6(p, k, 'd10') ? retest15Signal(p, k, { rb: 3, leash: 0.004, exit: '3R', swing: false }) : null),
});
add({
  id: 'S18_DEF_breakEntry', family: 'S18',
  label: 'RETEST rb3 l04 3R break-entry(no retest)',
  cdMin: 240,
  signal: (p, k) => (gate6(p, k, 'd10') ? breakEntry15Signal(p, k, { rb: 3, leash: 0.004 }) : null),
});
add({
  id: 'S18_gateoff', family: 'S18',
  label: 'RETEST rb3 l04 3R gate:off',
  cdMin: 240,
  signal: (p, k) => retest15Signal(p, k, { rb: 3, leash: 0.004, exit: '3R', swing: true }),
});

// ── S19: FILTERS on the shipped desks (round-19) ──────────────────────────────
// No new entry logic — each row is a frozen shipped base PLUS one guard. The two
// controls (S19_<base>_ctrl) must reproduce S7R6_2_d10 / S1R7_2_360 byte-for-byte.
const nr7Base19 = (p, k) => (gate6(p, k, 'd10') ? nr7v6Signal(p, k, 2.0, {}) : null);
const rsi2Base19 = (p, k) => (gate6(p, k, 'd10r') ? rsi2v6Signal(p, k, 2) : null);
// TOD — UTC session window on the entry minute (asia 00:00-08:00, us 13:30-20:00)
const todOk = (p, k, win) => {
  if (win === 'all') return true;
  const md = (p.time[k] % 86400e3) / 60000;
  if (win === 'asia') return md >= 0 && md < 480;
  if (win === 'us') return md >= 810 && md < 1200;
  return true;
};
// VREG — completed-bucket atr15 vs its trailing 5-day mean (causal, NaN-safe)
const vregOk = (p, k, band) => {
  if (band === 'all') return true;
  const b = p.i15[k];
  if (b < 0) return false;
  const r = p.atrRel15 ? p.atrRel15[b] : NaN;
  if (!Number.isFinite(r)) return false;
  if (band === 'calm') return r < 0.8;
  if (band === 'mid') return r >= 0.8 && r <= 1.5;
  if (band === 'hot') return r > 1.5;
  return true;
};
// RS — the symbol's trailing return must exceed BTC's over the SAME timestamps
const rsOk = (p, k, min) => {
  if (k < min || !p.btcC) return false;
  const sc = p.c[k], sp = p.c[k - min], bc = p.btcC[k], bp = p.btcC[k - min];
  if (!(sp > 0 && sc > 0 && bp > 0 && bc > 0)) return false;
  return (sc / sp) > (bc / bp);
};
const S19_BASES = [
  { name: 'NR7', fn: nr7Base19, cd: 0 },
  { name: 'RSI2', fn: rsi2Base19, cd: 360 },
];
const S19_FILTERS = [
  ['tod_asia', (p, k) => todOk(p, k, 'asia')],
  ['tod_us', (p, k) => todOk(p, k, 'us')],
  ['vreg_calm', (p, k) => vregOk(p, k, 'calm')],
  ['vreg_mid', (p, k) => vregOk(p, k, 'mid')],
  ['vreg_hot', (p, k) => vregOk(p, k, 'hot')],
  ['rs_12h', (p, k) => rsOk(p, k, 720)],
  ['rs_24h', (p, k) => rsOk(p, k, 1440)],
];
for (const B of S19_BASES) {
  add({
    id: `S19_${B.name}_ctrl`, family: 'S19', cdMin: B.cd,
    label: `${B.name} ctrl (shipped)`,
    signal: (p, k) => B.fn(p, k),
  });
  for (const [ftag, ffn] of S19_FILTERS) {
    add({
      id: `S19_${B.name}_${ftag}`, family: 'S19', cdMin: B.cd,
      label: `${B.name} ${ftag}`,
      signal: (p, k) => { const pl = B.fn(p, k); return pl && ffn(p, k) ? pl : null; },
    });
  }
  add({
    id: `S19_${B.name}_combo_us_mid`, family: 'S19', cdMin: B.cd,
    label: `${B.name} tod_us+vreg_mid`,
    signal: (p, k) => { const pl = B.fn(p, k); return pl && todOk(p, k, 'us') && vregOk(p, k, 'mid') ? pl : null; },
  });
  add({
    id: `S19_${B.name}_combo_us_rs24`, family: 'S19', cdMin: B.cd,
    label: `${B.name} tod_us+rs_24h`,
    signal: (p, k) => { const pl = B.fn(p, k); return pl && todOk(p, k, 'us') && rsOk(p, k, 1440) ? pl : null; },
  });
}

// ── S21: STRESSED-COST × REGIME-GATED re-validation (round-21) ────────────────
// No new entry logic — each row is a frozen shipped base (nr7Base19 / rsi2Base19)
// PLUS one book-level brake: a BTC medium-term (4H) regime gate. ctrl must
// reproduce the shipped rows byte-for-byte. Rule is pre-registered in the header.
const btcRegimeOk = (p, k, mode) => {
  if (mode === 'up') return p.btc4hUp[k] === 1;
  if (mode === 'notdn') return p.btc4hDn[k] !== 1;
  return true;
};
const S21_BASES = [
  { name: 'NR7', fn: nr7Base19, cd: 0 },
  { name: 'RSI2', fn: rsi2Base19, cd: 360 },
];
const S21_GATES = [
  ['ctrl', 'all'],
  ['g4h', 'up'],
  ['g4hnd', 'notdn'],
];
for (const B of S21_BASES) {
  for (const [gtag, mode] of S21_GATES) {
    add({
      id: `S21_${B.name}_${gtag}`, family: 'S21', cdMin: B.cd,
      label: `${B.name} ${gtag === 'ctrl' ? 'ctrl (shipped)' : 'btc4h:' + mode}`,
      signal: (p, k) => { const pl = B.fn(p, k); return pl && btcRegimeOk(p, k, mode) ? pl : null; },
    });
  }
}

// ── S1R6: RSI2v6 — sharpened daily gate + cooldown sweep ─────────────────────
function rsi2v6Signal(p, k, rsiTh) {
  if (!sym4hUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const b = p.i15[k];
  if (!(p.rsi2_15[b] < rsiTh)) return null;
  if (!trendUpAt(p, k)) return null;
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  if (!(p.volAvg15[b] > 0)) return null;
  if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
  const stopDist = 2.5 * atr;
  return {
    stopDist, targetDist: Infinity, dyn: null, eod: false, timeStopMin: 8 * H,
    trailDist: 2.5 * atr, armR: 0.5, priority: p.rsi2_15[b],
  };
}
for (const [gate, cdMin] of [['d10r', 180], ['d10r', 360], ['d10p', 180]]) {
  add({
    id: `S1R6_${gate}_${cdMin}`, family: 'S1R6',
    label: `RSI2v6 a0.5 4h:on cd${cdMin} gate:${gate}`,
    cdMin,
    signal: (p, k) => (gate6(p, k, gate) ? rsi2v6Signal(p, k, 3) : null),
  });
}

// ── S1R7: RSI2v7 — rarer capitulation thresholds (slot-competition relief) ───
for (const rsiTh of [1, 2]) {
  for (const cdMin of [180, 360]) {
    add({
      id: `S1R7_${rsiTh}_${cdMin}`, family: 'S1R7',
      label: `RSI2v7 rsi<${rsiTh} cd${cdMin} gate:d10r`,
      cdMin,
      signal: (p, k) => (gate6(p, k, 'd10r') ? rsi2v6Signal(p, k, rsiTh) : null),
    });
  }
}

// ── MIX: shared cap-3 book — NR7 first, RSI2 fills the quiet slots ───────────
for (const cdMin of [180, 360]) {
  add({
    id: `MIX_cd${cdMin}`, family: 'MIX',
    label: `NR7v6f2 + RSI2v6 cd${cdMin} gate:d10|d10r`,
    cdMin,
    signal: (p, k) => {
      if (!(p.btcUp[k] && p.btcD10[k])) return null;
      const nr = nr7v6Signal(p, k, 2.0, {});
      if (nr) { nr.priority = -1; return nr; }
      if (!p.btcD10r[k]) return null;
      return rsi2v6Signal(p, k, 3);
    },
  });
}

// ── MIX2: NR7 priority + rarer RSI2 fill (rsi<1|2) — the v6 mix failed because
// rsi<3 clusters monopolized the 3 slots; rsi<1 signals are ~1/day.
for (const rsiTh of [1, 2]) {
  add({
    id: `MIX2_rs${rsiTh}`, family: 'MIX2',
    label: `NR7v6f2 + RSI2v7(<${rsiTh}) cd360`,
    cdMin: 360,
    signal: (p, k) => {
      if (!(p.btcUp[k] && p.btcD10[k])) return null;
      const nr = nr7v6Signal(p, k, 2.0, {});
      if (nr) { nr.priority = -1; return nr; }
      if (!p.btcD10r[k]) return null;
      return rsi2v6Signal(p, k, rsiTh);
    },
  });
}

// ── S8: MR5-RSI2 — the RSI2v6 geometry moved to a 5m grid ────────────────────
// The flush the 15m desk buys after the bucket completes; on 5m the same dip
// is visible while it happens (and the desk can be flat again in ~2-3h). Every
// filter mirrors the shipped rsi2v6Signal exactly — momentum gate, ATR%-floor,
// climax volume, btcD10r + per-symbol 4H trend — only the grid and the time
// stop change. cdMin sweeps the post-stop cooldown (a fast grid re-fires often).
function rsi2_5Signal(p, k, rsiTh, tsH) {
  if (!sym4hUpAt(p, k)) return null;
  if (p.i5[k] < 14) return null;
  const b = p.i5[k];
  if (!(p.rsi2_5[b] < rsiTh)) return null;
  if (!trendUpAt(p, k)) return null;
  const atr = p.atr5[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  if (!(p.volAvg5[b] > 0)) return null;
  if (!(p.v5[b] >= 1.5 * p.volAvg5[b])) return null;
  const stopDist = 2.5 * atr;
  return {
    stopDist, targetDist: Infinity, dyn: null, eod: false, timeStopMin: tsH * H,
    trailDist: 2.5 * atr, armR: 0.5, priority: p.rsi2_5[b],
  };
}
for (const rsiTh of [1, 2, 3]) {
  for (const cdMin of [60, 120, 180]) {
    for (const tsH of [2, 3]) {
      add({
        id: `S8_${rsiTh}_${cdMin}_${tsH}`, family: 'S8',
        label: `MR5-RSI2<${rsiTh} cd${cdMin} ts${tsH}h gate:d10r`,
        cdMin,
        signal: (p, k) => (gate6(p, k, 'd10r') ? rsi2_5Signal(p, k, rsiTh, tsH) : null),
      });
    }
  }
}

// ── MIX5: does the fast filler steal NR7 slots or fill the idle ones? ────────
// Same shared cap-3 book as MIX/MIX2 — NR7v6f2 keeps absolute priority; the
// 5m dip desk only fills slots NR7 is not using. cd 120 matches the faster
// cycling of the 5m grid.
add({
  id: 'MIX5_rs2', family: 'MIX5',
  label: 'NR7v6f2 + MR5-RSI2(<2) cd120',
  cdMin: 120,
  signal: (p, k) => {
    if (!(p.btcUp[k] && p.btcD10[k])) return null;
    const nr = nr7v6Signal(p, k, 2.0, {});
    if (nr) { nr.priority = -1; return nr; }
    if (!p.btcD10r[k]) return null;
    return rsi2_5Signal(p, k, 2, 3);
  },
});

// ── S9: VWAP fade on the 15m grid — buy the dip under the session VWAP ───────
// Round 8 (5m RSI2) failed by catching price mid-liquidation; round 9 keeps
// the slower 15m grid and buys a DIFFERENT event: price stretched under the
// UTC-day session VWAP, the day's cumulative fair-value line. Every filter is
// deliberately level-based (VWAP distance, not momentum direction): the dip
// must close at least k×ATR below the VWAP, RSI(2)15 must show a real flush,
// volume must confirm, the session must be >=1h old (an hour of reference),
// ATR%-of-price >= 0.002 (no dead-vol symbols), and both the per-symbol 4H
// structure and the 1H trend must point up — dips are bought only in uptrends.
// Gate: the round-6 sharpened daily gate (btcUp + btcD10 + d10r). Exits sweep
// the three natural targets of a fade: back to the VWAP (clamp), dynamic exit
// on the first 15m close above the VWAP, or a plain 2R.
function vwapFade15Signal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const b = p.i15[k];
  const vw = p.vwap15[b];
  if (!Number.isFinite(vw) || !(vw > 0)) return null;
  if (!(p.sessAge15[b] >= 60)) return null;
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const dist = vw - p.c[k];
  if (!(dist >= cfg.kMult * atr)) return null;
  if (!(p.rsi2_15[b] < cfg.rsiTh)) return null;
  if (!(p.volAvg15[b] > 0)) return null;
  if (!(p.v15[b] >= 1.5 * p.volAvg15[b])) return null;
  if (!trendUpAt(p, k)) return null;
  const stopDist = cfg.stopMult * atr;
  let targetDist = Infinity;
  let dyn = null;
  if (cfg.exit === '2R') {
    targetDist = 2 * stopDist;
  } else if (cfg.exit === 'clamp') {
    // target = the VWAP-distance left to travel, clamped to [1×ATR, 4×ATR]
    targetDist = clampi(dist, 1.0 * atr, 4.0 * atr);
  } else { // 'vwap' — dynamic exit on the first 15m close back above the VWAP
    dyn = (q, i) => {
      const qb = q.i15[i];
      if (qb < 0 || qb === b) return false;
      return Number.isFinite(q.vwap15[qb]) && q.c15[qb] > q.vwap15[qb];
    };
  }
  return {
    stopDist, targetDist, dyn, eod: false, timeStopMin: cfg.tsH * H,
    priority: -dist / atr, // deepest stretch trades first in the shared book
  };
}
for (const kMult of [0.75, 1.5]) {
  for (const rsiTh of [5, 10]) {
    for (const stopMult of [1.5, 2.5]) {
      for (const exit of ['clamp', 'vwap', '2R']) {
        for (const tsH of [4, 8]) {
          const cfg = { kMult, rsiTh, stopMult, exit, tsH };
          add({
            id: `S9_${kMult}_${rsiTh}_${stopMult}_${exit}_${tsH}`, family: 'S9',
            label: `VWAPFade k${kMult} rsi<${rsiTh} s${stopMult} ${exit} ts${tsH}h`,
            cdMin: 240,
            signal: (p, k) => (gate6(p, k, 'd10r') ? vwapFade15Signal(p, k, cfg) : null),
          });
        }
      }
    }
  }
}

// ── MIX9: does the VWAP fade fill idle slots or crowd the shipped desks? ─────
// Same shared cap-3 shape as MIX/MIX2/MIX5 — NR7v6f2 keeps absolute priority
// (-1), RSI2v6 (rsi<2) keeps its natural rsi priority, and the VWAP fade fills
// only what remains (its stretch priority is remapped to [2, 2.75], strictly
// after both). The S9 config is FROZEN at the round-9 50d winner by the
// pre-registered rule — hard constraints (>=15 trades per half, both halves
// net-positive, portfolio expectancy >= the shipped RSI2 desk's same-window
// expectancy, max DD <= the $375 book band), then best min-half among the
// survivors: k0.75 rsi<5 stop2.5xATR exit:vwap ts8h (50d P-NET +$587.87,
// H1 +$386.35 / H2 +$201.53, DD $210, expectancy +$3.44/trade).
const S9_WINNER = { kMult: 0.75, rsiTh: 5, stopMult: 2.5, exit: 'vwap', tsH: 8 };
add({
  id: 'MIX9_winner', family: 'MIX9',
  label: 'NR7v6f2 + RSI2v6 + VWAPFade cd240',
  cdMin: 240,
  signal: (p, k) => {
    if (!(p.btcUp[k] && p.btcD10[k])) return null;
    const nr = nr7v6Signal(p, k, 2.0, {});
    if (nr) { nr.priority = -1; nr.tag = 'NR7'; return nr; }
    if (!p.btcD10r[k]) return null;
    const rs = rsi2v6Signal(p, k, 2);
    if (rs) { rs.tag = 'RSI2'; return rs; }
    const vf = vwapFade15Signal(p, k, S9_WINNER);
    if (vf) { vf.tag = 'VWAP'; vf.priority = 2.9 + clampi(vf.priority / 10, -0.9, 0); return vf; }
    return null;
  },
});

// ── S10: MOM-BO — buy strength: a 12h/24h high break on ignition volume ──────
// The family the book never had: every shipped desk buys weakness (NR7 squeeze,
// RSI2 flush, VWAP fade). A runner like a +11% day presents as a 1m close
// busting the multi-hour high on a volume surge — this desk buys THAT, caps the
// paid-up distance with a leash, and rides with a 2.5xATR trail (or a plain
// 3R). Gate: the round-6 sharpened daily gate (btcUp + btcD10 + SMA10 rising).
// cd240 posts a 4h per-symbol cooldown after a stop-out, same as the S9 family.
function momentum15Signal(p, k, cfg) {
  if (cfg.sym4h === 'on' && !sym4hUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const b = p.i15[k];
  const level = cfg.winH === 12 ? p.hi48[b] : p.hi96[b];
  if (!Number.isFinite(level)) return null;
  if (!(p.c[k] > level)) return null;
  if (!(p.c[k] <= level * (1 + cfg.leash / 100))) return null; // ran too far — refuse
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  if (!(p.volAvg15[b] > 0)) return null;
  const volRatio = p.v15[b] / p.volAvg15[b];
  if (!(volRatio >= 1.5)) return null;
  const stopDist = cfg.stopMult * atr;
  const plan = {
    stopDist,
    targetDist: cfg.exit === '3R' ? 3 * stopDist : Infinity,
    dyn: null, eod: false, timeStopMin: cfg.tsH * H,
    priority: -volRatio, // strongest ignition trades first in the shared book
  };
  if (cfg.exit === 'trail') { plan.trailDist = 2.5 * atr; plan.armR = 1.0; }
  return plan;
}
for (const winH of [12, 24]) {
  for (const leash of [0.75, 2]) {
    for (const stopMult of [1.5, 2.5]) {
      for (const exit of ['3R', 'trail']) {
        for (const sym4h of ['on', 'off']) {
          for (const tsH of [8, 24]) {
            const cfg = { winH, leash, stopMult, exit, sym4h, tsH };
            add({
              id: `S10_${winH}_${leash}_${stopMult}_${exit}_${sym4h}_${tsH}`, family: 'S10',
              label: `MOM-BO ${winH}h l${leash} s${stopMult} ${exit} 4h:${sym4h} ts${tsH}h`,
              cdMin: 240,
              signal: (p, k) => (gate6(p, k, 'd10r') ? momentum15Signal(p, k, cfg) : null),
            });
          }
        }
      }
    }
  }
}

// ── S11: ORB — opening-range breakout: the day's first impulse, bought ───────
// Every desk so far waits for a completed 15m event (squeeze / flush / fade);
// the day's FIRST information arrives at the session open. An opening range
// (the first 15/30 minutes after the anchor) defines the day's initial
// balance; the first 1m close back above the range high is the classic
// opening-range breakout entry. Risk is the range floor (or an ATR cap when
// the range is wide), the ride exits at the UTC close — EOD flat, never
// overnight. Anchors: 00:00 UTC (~ the Asian open, where the documented
// intraday trend persistence is strongest) and 13:30 UTC (US equity open).
// Gate axis: the round-6 sharpened gate (d10r) vs off — does opening momentum
// need the king's wind? Session axis: all vs the documented Monday-Asia window
// (Sun 23:00 -> Mon 23:00 UTC). cd240 is the house post-stop cooldown (a
// deliberate softening of the paper's once-per-day; noted in the report).
// Entries must be inside the anchor's own UTC day — a stale range is no range.
function orbSignal(p, k, cfg) {
  if (k < 1) return null;
  const ai = cfg.anchor === 'us' ? 1 : 0;
  const pi = ai * 2 + (cfg.win === 30 ? 1 : 0);
  if (!p.orbH || !p.orbH[pi]) return null;
  const t = p.time[k];
  const aOff = ai === 1 ? 13.5 * 3600e3 : 0;
  const anchorT = Math.floor((t - aOff) / 86400e3) * 86400e3 + aOff;
  const di = (anchorT - p.orbBase[ai]) / 86400e3;
  if (!(di >= 0) || !Number.isInteger(di)) return null;
  const H0 = p.orbH[pi][di];
  if (!Number.isFinite(H0)) return null;
  if (!(t < anchorT + 86400e3 - aOff)) return null; // entry must sit inside the anchor's UTC day
  if (cfg.session === 'mon') {
    const s = t + 3600e3; // shift: the Sun 23:00 UTC window start becomes a midnight
    if (((Math.floor(s / 86400e3) % 7) + 7) % 7 !== 4) return null; // ...and that day a Monday
  }
  const c0 = p.c[k], c1 = p.c[k - 1];
  if (!(c0 > H0) || !(c1 <= H0)) return null; // first 1m close back above the range high
  const L0 = p.orbL[pi][di];
  if (!Number.isFinite(L0)) return null;
  if (!has15(p, k)) return null;
  const atr = p.atr15[p.i15[k]];
  if (!(atr > 0)) return null;
  if (!(atr / c0 >= 0.002)) return null;
  const stopDist = cfg.stop === 'atrp' ? Math.min(c0 - L0, 1.5 * atr) : c0 - L0;
  if (!(stopDist > 0) || !Number.isFinite(stopDist)) return null;
  const plan = {
    stopDist,
    targetDist: cfg.exit === '3R' ? 3 * stopDist : Infinity,
    dyn: null, eod: true, timeStopMin: 12 * H,
    priority: (t - anchorT) / 60000, // the day's earliest break fills the book first
  };
  if (cfg.exit === 'trail') { plan.trailDist = 2.5 * atr; plan.armR = 1.0; }
  return plan;
}
for (const anchor of ['asia', 'us']) {
  for (const win of [15, 30]) {
    for (const stop of ['range', 'atrp']) {
      for (const exit of ['3R', 'trail']) {
        for (const gate of ['d10r', 'off']) {
          for (const session of ['all', 'mon']) {
            const cfg = { anchor, win, stop, exit, gate, session };
            add({
              id: `S11_${anchor}_${win}_${stop}_${exit}_${gate}_${session}`, family: 'S11',
              label: `ORB ${anchor}${win} ${stop} ${exit} g:${gate} ${session}`,
              cdMin: 240,
              signal: (p, k) => ((cfg.gate === 'off' || gate6(p, k, 'd10r')) ? orbSignal(p, k, cfg) : null),
            });
          }
        }
      }
    }
  }
}

// ── S12: GATE ABLATION — does the BTC gate earn its keep? (round 12) ─────────
// Not a new edge: the signal code is frozen at the two shipped geometries; the
// gate is the single axis. no1h drops btcUp only (daily reads stand), daily
// drops the daily reads only (btcUp stands), off drops the whole BTC gate,
// d10 = only the daily position wall (the live switch's OFF shape, round-12b).
// 'cur' = the shipped compound gate, covered by the S7R6_2_d10 / S1R7_2_360
// baselines in the same battery. Pre-registered rule lives in the header.
// CD mirrors each desk's shipped cooldown (RSI2 6h; NR7 none).
const gate12 = (p, k, desk, mode) => {
  if (mode === 'off') return true;
  if (mode === 'd10') return p.btcD10[k]; // switch-OFF shape: btcUp + btcD10r both bypassed
  if (mode !== 'no1h' && !p.btcUp[k]) return false;
  if (mode !== 'daily' && !p.btcD10[k]) return false;
  if (desk === 'RSI2' && mode !== 'daily' && !p.btcD10r[k]) return false;
  return true;
};
for (const mode of ['no1h', 'daily', 'off']) {
  add({
    id: `S12_nr7_${mode}`, family: 'S12',
    label: `GATE-ABL NR7v6f2 gate:${mode}`,
    signal: (p, k) => (gate12(p, k, 'NR7', mode) ? nr7v6Signal(p, k, 2.0, {}) : null),
  });
  add({
    id: `S12_rsi2_${mode}`, family: 'S12',
    label: `GATE-ABL RSI2v7<2 cd360 gate:${mode}`,
    cdMin: 360,
    signal: (p, k) => (gate12(p, k, 'RSI2', mode) ? rsi2v6Signal(p, k, 2) : null),
  });
}
// Round-12b — the switch's new OFF shape for the capitulation desk (btcD10
// only). Mechanism reading only; the switch is a manual lever, never a port.
add({
  id: 'S12_rsi2_d10', family: 'S12',
  label: 'GATE-ABL RSI2v7<2 cd360 gate:d10only',
  cdMin: 360,
  signal: (p, k) => (gate12(p, k, 'RSI2', 'd10') ? rsi2v6Signal(p, k, 2) : null),
});

// ── S13: THE SCALP CANON — VWAP bounce/reclaim + fast EMA pullback (round 13) ─
// The two canonical scalping expressions this lab has never run: buying the
// PULLBACK in an established intraday uptrend (the opposite trade to the S3/S9
// stretch-fades — those bought the washout below VWAP; this buys the hold AT
// the line). 15m structure decides, the 1m tape triggers, fees+slip charged.
function vwapBounceSignal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const b = p.i15[k];
  const vw = p.vwap15[b];
  if (!Number.isFinite(vw) || !(vw > 0)) return null;
  if (!(p.sessAge15[b] >= 180)) return null;   // a formed session, not the opening chop
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  // the completed bucket tested the line from above
  if (cfg.mode === 'reclaim') {
    if (!(p.l15[b] < vw - 0.1 * atr)) return null;   // a real undercut...
    if (!(p.c15[b] > vw)) return null;               // ...reclaimed by the close
  } else {
    if (!(p.l15[b] <= vw + 0.25 * atr)) return null; // touched the line...
    if (!(p.c15[b] > vw)) return null;               // ...and held it
  }
  // 1m trigger: a bullish close above the line, never chasing the bounce
  if (!(p.c[k] > p.o[k])) return null;
  if (!(p.c[k] > vw)) return null;
  if (p.c[k] > vw + 1.0 * atr) return null;
  const mod = (p.time[k] % 86400e3) / 60000;
  if (cfg.sess === 'us' && (mod < 810 || mod > 1200)) return null;
  let stopDist;
  if (cfg.stop === 'struct') {
    stopDist = clampi(p.c[k] - (p.l15[b] - 0.25 * atr), 0.75 * atr, 2.5 * atr);
  } else {
    stopDist = 1.5 * atr;
  }
  let targetDist = Infinity, dyn = null, trailDist = 0;
  if (cfg.exit === '2R') targetDist = 2 * stopDist;
  else if (cfg.exit === 'trail') trailDist = 1.5 * atr;
  else dyn = (q, i) => {   // vwapLost: the 15m tape closes back under the line
    const qb = q.i15[i];
    if (qb < 0 || qb === b) return false;
    return !(Number.isFinite(q.vwap15[qb]) && q.c15[qb] > q.vwap15[qb]);
  };
  return {
    stopDist, targetDist, dyn, eod: false, timeStopMin: 6 * H,
    trailDist, armR: 1, priority: (p.c[k] - vw) / atr,
  };
}
for (const mode of ['keep', 'reclaim']) {
  for (const stop of ['struct', 'atr']) {
    for (const exit of ['2R', 'trail', 'vwapLost']) {
      for (const sess of ['all', 'us']) {
        const cfg = { mode, stop, exit, sess };
        add({
          id: `S13_rc_${mode}_${stop}_${exit}_${sess}`, family: 'S13',
          label: `RCLM ${mode} stop:${stop} ${exit} sess:${sess}`,
          cdMin: 240,
          signal: (p, k) => (gate6(p, k, 'd10') ? vwapBounceSignal(p, k, cfg) : null),
        });
      }
    }
  }
}
function emaPullSignal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k) || p.i15[k] < 25) return null;
  const b = p.i15[k];
  const e9 = p.ema9_15[b], e21 = p.ema21_15[b];
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return null;
  if (!(e9 > e21)) return null;
  if (!(Number.isFinite(p.ema21_15[b - 3]) && e21 > p.ema21_15[b - 3])) return null;
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const zone = cfg.touch === 'fast' ? e9 : e21;
  if (!(p.l15[b] <= zone + 0.25 * atr)) return null;   // tagged the line
  if (!(p.c15[b] > zone)) return null;                 // closed back above it
  if (p.c15[b] > e9 + 1.5 * atr) return null;          // not extended
  // 1m trigger: a bullish close reclaiming the completed bucket's close
  if (!(p.c[k] > p.o[k])) return null;
  if (!(p.c[k] > p.c15[b])) return null;
  const mod = (p.time[k] % 86400e3) / 60000;
  if (cfg.sess === 'us' && (mod < 810 || mod > 1200)) return null;
  let stopDist;
  if (cfg.stop === 'struct') {
    stopDist = clampi(p.c[k] - (p.l15[b] - 0.25 * atr), 0.5 * atr, 2.0 * atr);
  } else {
    stopDist = 1.5 * atr;
  }
  let targetDist = Infinity, trailDist = 0;
  if (cfg.exit === '2R') targetDist = 2 * stopDist;
  else trailDist = 1.5 * atr;
  return {
    stopDist, targetDist, dyn: null, eod: false, timeStopMin: 6 * H,
    trailDist, armR: 1, priority: p.c15[b] / e21,
  };
}
for (const touch of ['fast', 'slow']) {
  for (const stop of ['struct', 'atr']) {
    for (const exit of ['2R', 'trail']) {
      for (const sess of ['all', 'us']) {
        const cfg = { touch, stop, exit, sess };
        add({
          id: `S13_ep_${touch}_${stop}_${exit}_${sess}`, family: 'S13',
          label: `EPULL t${touch} stop:${stop} ${exit} sess:${sess}`,
          cdMin: 180,
          signal: (p, k) => (gate6(p, k, 'd10') ? emaPullSignal(p, k, cfg) : null),
        });
      }
    }
  }
}

// ── S14: SESSION DRIFT — the time-based day canon (round 14) ──────────────────
// Not an event — a TIME. The session's first half-hour return predicts the
// rest of the day (market intraday momentum, Gao-Han-Li-Zhou JFE 2018; for
// BTC intraday series the effect persists per Shen 2022). cond up buys the
// momentum read; down buys the reversal read (morning weakness held for the
// close). Entry only inside the 5-minute firing window — one shot per symbol
// per day. House DNA carried (4h up, 1h up, ATR%-floor); pre-registered rule
// in the header.
function sessionDriftSignal(p, k, cfg) {
  if (!sym4hUpAt(p, k)) return null;
  if (!trendUpAt(p, k)) return null;
  if (!has15(p, k)) return null;
  const b = p.i15[k];
  const atr = p.atr15[b];
  if (!(atr > 0)) return null;
  if (!(atr / p.c[k] >= 0.002)) return null;
  const md = (p.time[k] % 86400e3) / 60000;
  const w0 = cfg.fire === 30 ? 840 : 870;
  if (md < w0 || md >= w0 + 5) return null;
  const ax = p.usOpenPx[k];
  if (!Number.isFinite(ax) || !(ax > 0)) return null;
  const ret = p.c[k] / ax - 1;
  if (cfg.cond === 'up' ? !(ret > 0) : !(ret < 0)) return null;
  let stopDist;
  if (cfg.stop === 'struct') {
    stopDist = clampi(p.c[k] - (p.dayLow[k] - 0.25 * atr), 0.75 * atr, 2.5 * atr);
  } else {
    stopDist = 1.5 * atr;
  }
  let dyn = null, trailDist = 0;
  if (cfg.exit === 'usclose') dyn = (q, i) => (q.time[i] % 86400e3) / 60000 >= 1200;
  else if (cfg.exit === 'trail') trailDist = 1.5 * atr;
  return {
    stopDist, targetDist: Infinity, dyn, eod: true, timeStopMin: 12 * H,
    trailDist, armR: 1, priority: cfg.cond === 'up' ? -ret : ret,
  };
}
for (const fire of [30, 60]) {
  for (const cond of ['up', 'down']) {
    for (const stop of ['atr', 'struct']) {
      for (const exit of ['eod', 'usclose', 'trail']) {
        for (const gate of ['d10', 'off']) {
          const cfg = { fire, cond, stop, exit, gate };
          add({
            id: `S14_dr_${fire}_${cond}_${stop}_${exit}_${gate}`, family: 'S14',
            label: `DRIFT f${fire} ${cond} stop:${stop} ${exit} gate:${gate}`,
            cdMin: 600,
            signal: (p, k) => (cfg.gate === 'd10' && !gate6(p, k, 'd10') ? null : sessionDriftSignal(p, k, cfg)),
          });
        }
      }
    }
  }
}

// ── S15: REVERSAL-READ ROBUSTNESS (round 15) — the frozen survivor + collar ──
// One question only: does the round-14 survivor survive the concentration
// collar? Geometry is frozen at fire60 x cond down x stop struct x exit eod
// x gate d10 — the signal function, priority and DNA are byte-identical to
// the S14 study row; the collar axes are the only new knobs (header rule).
const S15_FROZEN = { fire: 60, cond: 'down', stop: 'struct', exit: 'eod' };
for (const symcd of ['base', 'any24', 'any48']) {
  for (const topn of ['cap', 'day1']) {
    add({
      id: `S15_rc_${symcd}_${topn}`, family: 'S15',
      label: `DRIFT-REV symcd:${symcd} topn:${topn}`,
      cdMin: symcd === 'base' ? 600 : symcd === 'any24' ? 1440 : 2880,
      armAnyExit: symcd !== 'base',
      dailyEntryCap: topn === 'day1' ? 1 : 0,
      signal: (p, k) => (gate6(p, k, 'd10') ? sessionDriftSignal(p, k, S15_FROZEN) : null),
    });
  }
}

// ── SIMULATOR ─────────────────────────────────────────────────────────────────
// One position lifecycle shared by both replay modes:
//   simPerSymbol  — classic research mode: every symbol trades independently
//   simPortfolio  — live-style book: at most `cap` concurrent slots across the
//                   universe, filled best-signal-first (plan.priority asc)
// manageBar() owns exit semantics: gap-through-stop fills at the open, a bar
// that touches both stop and target counts the stop, dynamic/EOD/time exits
// fill at the bar close (pessimistic), and the trailing ratchet only tightens.
function feesOn(pnlPct, cfg) { return pnlPct - 2 * cfg.fee * 100; }

function manageBar(p, pos, k, cfg) {
  const o = p.o[k], hh = p.h[k], ll = p.l[k], cc = p.c[k];
  const half = (cfg.spread || 0) / 2;   // every sell crosses half the spread (0 when unpriced)
  let exit = null, reason = null;
  if (o <= pos.stop) { exit = o - (cfg.slip + half) * o; reason = 'STOP'; }
  else if (ll <= pos.stop) { exit = pos.stop - (cfg.slip + half) * pos.stop; reason = 'STOP'; }
  else if (hh >= pos.target) { exit = pos.target * (1 - half); reason = 'WIN'; }
  else if (pos.dyn && pos.dyn(p, k)) { exit = cc - (cfg.slip + half) * cc; reason = 'DYN'; }
  else if (pos.eod && (p.time[k] + 60000) % 86400e3 === 0) { exit = cc - (cfg.slip + half) * cc; reason = 'EOD'; }
  else if (k - pos.entryIdx >= pos.timeStopMin) { exit = cc - (cfg.slip + half) * cc; reason = 'TIME'; }
  if (exit == null) {
    if (hh > pos.peak) pos.peak = hh;
    // trailing stop: once MFE >= armR x initial risk the ratchet may only tighten
    if (pos.trailDist > 0 && pos.risk0 > 0 && pos.peak >= pos.entry + pos.armR * pos.risk0) {
      const trailed = pos.peak - pos.trailDist;
      if (trailed > pos.stop) pos.stop = trailed;
    }
    return null;
  }
  const pnlPct = feesOn((exit / pos.entry - 1) * 100, cfg);
  return {
    symbol: p.symbol, tag: pos.tag, entryT: pos.entryT, exitT: p.time[k], entry: pos.entry, exit,
    reason, holdMin: k - pos.entryIdx, pnlPct, net: cfg.notional * pnlPct / 100,
  };
}

function openPosition(p, plan, k, cfg) {
  const nk = k + 1;
  const fill = p.o[nk] * (1 + cfg.slip + (cfg.spread || 0) / 2);
  return {
    entry: fill, entryT: p.time[nk], entryIdx: nk,
    stop: fill - plan.stopDist,
    target: Number.isFinite(plan.targetDist) && plan.targetDist > 0 ? fill + plan.targetDist : Infinity,
    dyn: plan.dyn || null, eod: !!plan.eod, timeStopMin: plan.timeStopMin || 8 * H,
    risk0: plan.stopDist, peak: fill, tag: plan.tag || null,
    trailDist: plan.trailDist > 0 ? plan.trailDist : 0, armR: plan.armR > 0 ? plan.armR : 1,
  };
}

function simPerSymbol(p, variant, cfg) {
  const trades = [];
  const n = p.n;
  let pos = null;
  let cooldownUntil = 0;

  for (let k = p.evalStart; k < n - 1; k++) {
    if (pos) {
      const rec = manageBar(p, pos, k, cfg);
      if (rec) {
        trades.push(rec);
        if (cfg.cooldownMin > 0 && (rec.net < 0 || cfg.armAnyExit)) cooldownUntil = rec.exitT + cfg.cooldownMin * 60000;
        pos = null;
      }
      continue;
    }
    if (cfg.threatGate && p.threatBlock[k]) continue;
    if (cfg.cooldownMin > 0 && p.time[k] < cooldownUntil) continue;
    const plan = variant.signal(p, k);
    if (!plan) continue;
    if (!(plan.stopDist > 0) || !Number.isFinite(plan.stopDist)) continue;
    pos = openPosition(p, plan, k, cfg);
  }
  // still-open at end: net 0, excluded from stats (counted separately)
  return { trades, openAtEnd: pos ? 1 : 0 };
}

/** Per-symbol local index aligned to the global minute list (-1 where absent). */
function buildAlign(prepared, minuteList) {
  const out = new Map();
  for (const p of prepared) {
    const arr = new Int32Array(minuteList.length).fill(-1);
    let i = 0;
    for (let g = 0; g < minuteList.length; g++) {
      const t = minuteList[g];
      while (i < p.n && p.time[i] < t) i++;
      if (i < p.n && p.time[i] === t) arr[g] = i;
    }
    out.set(p.symbol, arr);
  }
  return out;
}

function simPortfolio(prepared, variant, cfg, minuteList, cap, align) {
  const trades = [];
  const open = new Map();          // symbol -> { p, pos }
  const cooldownUntil = new Map();
  const dayEntries = new Map();    // round-15 collar: book entries per UTC day (topn day1)
  let maxConcurrent = 0;

  for (let g = 0; g < minuteList.length; g++) {
    // 1) exits first — this frees slots for the same minute's candidates
    if (open.size) {
      for (const [sym, slot] of open) {
        const k = align.get(sym)[g];
        if (k < 0) continue;
        const rec = manageBar(slot.p, slot.pos, k, cfg);
        if (rec) {
          trades.push(rec);
          if (cfg.cooldownMin > 0 && (rec.net < 0 || cfg.armAnyExit)) cooldownUntil.set(sym, rec.exitT + cfg.cooldownMin * 60000);
          open.delete(sym);
        }
      }
    }
    // 2) fill free slots from this minute's candidates, best signal first
    if (open.size >= cap) continue;
    const cands = [];
    for (const p of prepared) {
      if (open.has(p.symbol)) continue;
      const k = align.get(p.symbol)[g];
      if (k < p.evalStart || k >= p.n - 1) continue;
      if (cfg.cooldownMin > 0) {
        const until = cooldownUntil.get(p.symbol);
        if (until != null && p.time[k] < until) continue;
      }
      if (cfg.threatGate && p.threatBlock[k]) continue;
      const plan = variant.signal(p, k);
      if (!plan) continue;
      if (!(plan.stopDist > 0) || !Number.isFinite(plan.stopDist)) continue;
      cands.push({ p, k, plan });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => (a.plan.priority ?? 0) - (b.plan.priority ?? 0) || (a.p.symbol < b.p.symbol ? -1 : 1));
    for (const c of cands) {
      if (open.size >= cap) break;
      if (cfg.dailyEntryCap > 0) {
        const dk = Math.floor(c.p.time[c.k + 1] / 86400e3);
        if ((dayEntries.get(dk) || 0) >= cfg.dailyEntryCap) continue;
        dayEntries.set(dk, (dayEntries.get(dk) || 0) + 1);
      }
      open.set(c.p.symbol, { p: c.p, pos: openPosition(c.p, c.plan, c.k, cfg) });
    }
    if (open.size > maxConcurrent) maxConcurrent = open.size;
  }
  return { trades, openAtEnd: open.size, maxConcurrent };
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function summarize(trades, openAtEnd, label, cfg) {
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = losses.reduce((a, t) => a + t.net, 0);
  const net = trades.reduce((a, t) => a + t.net, 0);

  const byExit = trades.slice().sort((a, b) => a.exitT - b.exitT);
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of byExit) { eq += t.net; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }

  const h1 = trades.filter(t => t.entryT < HALF_SPLIT);
  const h2 = trades.filter(t => t.entryT >= HALF_SPLIT);
  const s1 = h1.reduce((a, t) => a + t.net, 0);
  const s2 = h2.reduce((a, t) => a + t.net, 0);
  const score = (h1.length >= cfg.minHalfTrades && h2.length >= cfg.minHalfTrades)
    ? Math.min(s1, s2) : -1e9;

  const monthly = {};
  for (const t of byExit) {
    const key = new Date(t.exitT).toISOString().slice(0, 7);
    const m = monthly[key] = monthly[key] || { trades: 0, wins: 0, net: 0 };
    m.trades++; if (t.net > 0) m.wins++; m.net += t.net;
  }
  const perSymbol = {};
  for (const t of trades) {
    const s = perSymbol[t.symbol] = perSymbol[t.symbol] || { trades: 0, wins: 0, net: 0 };
    s.trades++; if (t.net > 0) s.wins++; s.net += t.net;
  }
  // per-tag split with halves — only the MIX books tag their plans (NR7/RSI2/
  // VWAP); everything else lands in the 'book' bucket. The NR7-tag slice is
  // what the port gate compares against NR7's standalone halves.
  const byTag = {};
  for (const t of trades) {
    const tg = t.tag || 'book';
    const e = byTag[tg] = byTag[tg] || { trades: 0, wins: 0, net: 0, h1: { trades: 0, net: 0 }, h2: { trades: 0, net: 0 } };
    e.trades++; if (t.net > 0) e.wins++; e.net += t.net;
    if (t.entryT < HALF_SPLIT) { e.h1.trades++; e.h1.net += t.net; } else { e.h2.trades++; e.h2.net += t.net; }
  }

  const avgHold = trades.length ? trades.reduce((a, t) => a + t.holdMin, 0) / trades.length : 0;
  const byReason = {};
  for (const t of trades) {
    const r = byReason[t.reason] = byReason[t.reason] || { trades: 0, wins: 0, net: 0 };
    r.trades++; if (t.net > 0) r.wins++; r.net += t.net;
  }
  return {
    label, trades: trades.length, wins: wins.length, losses: losses.length, openAtEnd,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss !== 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? Infinity : 0),
    net, expectancy: trades.length ? net / trades.length : 0,
    maxDD, h1: { trades: h1.length, net: s1 }, h2: { trades: h2.length, net: s2 }, score,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    avgHoldMin: avgHold, tradesPerDay: trades.length / cfg.days,
    monthly, perSymbol, byTag, byReason,
  };
}

// ── REPORTING ─────────────────────────────────────────────────────────────────
function printComparison(rows, top, usePortfolio) {
  const sel = (r) => (usePortfolio && r.portStats ? r.portStats : r.stats);
  banner(usePortfolio
    ? `== VARIANT LEADERBOARD (portfolio replay, cap ${CFG.portfolioCap} slots; sorted by portfolio min-half net) ==`
    : `== VARIANT LEADERBOARD (sorted by min-half net; both halves must trade) ==`);
  if (usePortfolio) {
    console.log(`  ${pad('VARIANT', 44)}${padL('P-TR', 6)}${padL('P-WR%', 7)}${padL('P-PF', 6)}${padL('P-NET', 10)}${padL('P-H1', 9)}${padL('P-H2', 9)}${padL('P-DD', 8)}${padL('S-TR', 6)}${padL('S-NET', 10)}`);
    for (const r of rows.slice(0, top)) {
      const s = sel(r);
      console.log(`  ${pad(r.label.slice(0, 43), 44)}${padL(s.trades, 6)}${padL(s.winRate.toFixed(1), 7)}` +
        `${padL(s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2), 6)}${padL(fmt$(s.net), 10)}` +
        `${padL(fmt$(s.h1.net), 9)}${padL(fmt$(s.h2.net), 9)}${padL('$' + Math.abs(s.maxDD).toFixed(0), 8)}` +
        `${padL(r.stats.trades, 6)}${padL(fmt$(r.stats.net), 10)}`);
    }
  } else {
    console.log(`  ${pad('VARIANT', 44)}${padL('TRADES', 7)}${padL('WR%', 6)}${padL('PF', 6)}${padL('NET', 10)}${padL('H1', 9)}${padL('H2', 9)}${padL('EXP/TR', 8)}${padL('MAXDD', 9)}${padL('TR/DAY', 7)}`);
    for (const r of rows.slice(0, top)) {
      const s = r.stats;
      console.log(`  ${pad(r.label.slice(0, 43), 44)}${padL(s.trades, 7)}${padL(s.winRate.toFixed(1), 6)}` +
        `${padL(s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2), 6)}${padL(fmt$(s.net), 10)}` +
        `${padL(fmt$(s.h1.net), 9)}${padL(fmt$(s.h2.net), 9)}${padL(fmt$(s.expectancy), 8)}${padL('$' + Math.abs(s.maxDD).toFixed(0), 9)}${padL(s.tradesPerDay.toFixed(2), 7)}`);
    }
  }
  const fails = rows.filter(r => sel(r).score === -1e9).length;
  console.log(`  (${fails} variants below the ${CFG.minHalfTrades}-trades-per-half significance bar — ranked last)`);
}

function printDetail(s, cfg, label) {
  banner(`== ${label} ==`);
  console.log(`  Trades: ${s.trades} (W/L: ${s.wins}/${s.losses})  open at end: ${s.openAtEnd}  ${s.tradesPerDay.toFixed(2)}/day`);
  console.log(`  Win rate: ${s.winRate.toFixed(1)}%   PF: ${s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2)}   Expectancy: ${fmt$(s.expectancy)}/trade on $${cfg.notional}`);
  console.log(`  Net: ${fmt$(s.net)}   Max DD: $${Math.abs(s.maxDD).toFixed(2)}   Avg win: ${fmt$(s.avgWin)}  Avg loss: ${fmt$(s.avgLoss)}   Avg hold: ${(s.avgHoldMin / 60).toFixed(1)}h`);
  console.log(`  Halves: H1 ${s.h1.trades} trades ${fmt$(s.h1.net)} | H2 ${s.h2.trades} trades ${fmt$(s.h2.net)}`);
  console.log('  Monthly:');
  for (const [k, m] of Object.entries(s.monthly).sort()) {
    console.log(`    ${k}: ${padL(m.trades, 4)} trades  WR ${padL(((m.wins / m.trades) * 100).toFixed(0) + '%', 4)}  net ${fmt$(m.net)}`);
  }
  const syms = Object.entries(s.perSymbol).map(([sym, v]) => ({ sym, ...v })).sort((a, b) => b.net - a.net);
  console.log(`  Best symbols:  ${syms.slice(0, 5).map(x => `${x.sym.split('-')[0]} ${fmt$(x.net)}`).join(' · ')}`);
  console.log(`  Worst symbols: ${syms.slice(-5).map(x => `${x.sym.split('-')[0]} ${fmt$(x.net)}`).join(' · ')}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const universe = (CFG.symbols || SYMBOLS).filter(s => {
    const base = s.split('-')[0];
    if (BINANCE_SKIP.includes(base)) return false;
    if (CFG.excludeSymbols && (CFG.excludeSymbols.includes(base) || CFG.excludeSymbols.includes(s))) return false;
    return true;
  });

  console.log('DAY-TRADING STRATEGY RESEARCH LAB');
  console.log(`  Window: ${CFG.days} days (warmup ${CFG.warmupDays}d) | ${universe.length} symbols | ${variants.length} variants`);
  console.log(`  ${iso(WINDOW_START)}  ->  ${iso(NOW)}`);
  console.log(`  Fee ${(CFG.fee * 100).toFixed(2)}%/side | slip ${(CFG.slip * 100).toFixed(2)}%/fill | spread ${(CFG.spread * 100).toFixed(2)}%/round-trip | notional $${CFG.notional} | threat gate ${CFG.threatGate ? 'ON' : 'OFF'}`);

  banner('== FETCHING 1m KLINES (shared cache; backfills + extends) ==');
  const pairBySymbol = new Map();
  const uniquePairs = new Set();
  for (const s of universe) {
    const base = s.split('-')[0];
    const pair = (BINANCE_MAP[base] || base) + 'USDT';
    pairBySymbol.set(s, pair);
    uniquePairs.add(pair);
  }
  const rowsByPair = new Map();
  let fetchTotal = 0;
  const pairList = [...uniquePairs];
  for (let w = 0; w < pairList.length; w += CFG.concurrency) {
    const wave = pairList.slice(w, w + CFG.concurrency);
    await Promise.all(wave.map(async (pair) => {
      try {
        const { rows, reqs } = await loadPair(pair);
        fetchTotal += reqs;
        rowsByPair.set(pair, rows);
        if (reqs > 0) process.stdout.write(`  ${pad(pair, 11)} +${reqs} requests -> ${rows.length} candles\n`);
      } catch (err) {
        console.warn(`  FAILED ${pair}: ${err.message}`);
      }
    }));
  }
  console.log(`  ${pairList.length} pairs on disk (${fetchTotal} fetches this run)`);

  const prepared = [];
  for (const s of universe) {
    const rows = rowsByPair.get(pairBySymbol.get(s));
    if (!rows || !rows.length) continue;
    const p = prepare(s, rows);
    if (p) prepared.push(p);
  }
  const bySymbol = new Map(prepared.map(p => [p.symbol, p]));
  attachContext(prepared, bySymbol);
  console.log(`  ${prepared.length} symbols prepared`);

  // ── RAW SIGNAL DUMP (port-fidelity harness for src/lib/daydesk.js) ───────────
  // For the two LOCKED day desks, log every minute where the desk's 15m/1m
  // "body" conditions hold (everything INDEPENDENT of the windowed 1h/4h gates),
  // together with the research gate vector and whether the full variant fired.
  // scripts/verify-daydesk.mjs replays these minutes through the production
  // module and compares fire-for-fire, gate-for-gate.
  if (CFG.dumpSignals) {
    const LOCKED = ['S7R6_2_d10', 'S1R7_2_360'];
    const out = [];
    for (const vid of LOCKED) {
      const v = variants.find(x => x.id === vid);
      if (!v) { console.warn(`  dump: ${vid} not in the battery (add --only S7R6,S1R7)`); continue; }
      const body = v.family === 'S7R6'
        ? (p, k) => {           // NR7 body — gates (btcUp/D10, sym4hUp) excluded
            if (!has15(p, k) || p.i15[k] < 7) return false;
            const nb = p.i15[k];
            const r = p.range15[nb];
            if (!(r > 0)) return false;
            for (let j = nb - 6; j < nb; j++) if (p.range15[j] <= r) return false;
            const lvl = p.h15[nb];
            if (!(p.c[k] > lvl)) return false;
            if (!(p.c[k] <= lvl * 1.004)) return false;
            const rng = p.h[k] - p.l[k];
            if (!(rng > 0) || (p.c[k] - p.l[k]) / rng < 0.6) return false;
            if (!(p.volAvg15[nb] > 0)) return false;
            if (!(p.v15[nb] >= 1.5 * p.volAvg15[nb])) return false;
            return p.atr15[nb] > 0;
          }
        : (p, k) => {           // RSI2 body — gates (btcUp/D10/D10r, trendUp, sym4hUp) excluded
            if (!has15(p, k)) return false;
            const b = p.i15[k];
            if (!(p.rsi2_15[b] < 2)) return false;
            const atr = p.atr15[b];
            if (!(atr > 0)) return false;
            if (!(atr / p.c[k] >= 0.002)) return false;
            if (!(p.volAvg15[b] > 0)) return false;
            return p.v15[b] >= 1.5 * p.volAvg15[b];
          };
      let bodyN = 0, firedN = 0;
      for (const p of prepared) {
        for (let k = p.evalStart; k < p.n; k++) {
          const plan = v.signal(p, k);
          let ok = body(p, k);
          if (plan && !ok) {
            console.error(`  dump ASSERT: ${vid} fired outside the transcribed body — ${p.symbol} ${p.time[k]} (recording anyway)`);
            ok = true; // never lose a fired minute — coverage is the point
          }
          if (!ok) continue;
          bodyN++;
          const fired = plan ? 1 : 0;
          firedN += fired;
          const bits = (p.btcUp[k] ? 1 : 0) | (p.btcD10[k] ? 2 : 0) | (p.btcD10r[k] ? 4 : 0)
            | (trendUpAt(p, k) ? 8 : 0) | (sym4hUpAt(p, k) ? 16 : 0);
          out.push([vid, p.symbol, p.time[k], bits, fired,
            plan ? +plan.stopDist.toPrecision(10) : null,
            plan ? (Number.isFinite(plan.targetDist) ? +plan.targetDist.toPrecision(10) : 'inf') : null,
            plan && plan.trailDist != null ? +plan.trailDist.toPrecision(10) : null,
            plan && plan.armR != null ? plan.armR : null]);
        }
      }
      console.log(`  dump ${vid}: ${bodyN} body-ok minutes, ${firedN} fired`);
    }
    if (!out.length) {
      console.warn('  dump: nothing to write — LOCKED variants not in this battery; existing dump left intact');
    } else {
      fs.mkdirSync(path.dirname(CFG.dumpSignals), { recursive: true });
      fs.writeFileSync(CFG.dumpSignals, JSON.stringify({
        window: { start: WINDOW_START, end: NOW, days: CFG.days },
        symbols: prepared.map(p => p.symbol),
        signals: out,
      }));
      console.log(`  ${out.length} body-ok minutes dumped -> ${CFG.dumpSignals}`);
    }
  }

  // market context preamble
  const btc = bySymbol.get('BTC-USDT');
  if (btc) {
    const i0 = btc.evalStart, i1 = btc.n - 1;
    const chg = (btc.c[i1] / btc.c[i0] - 1) * 100;
    console.log(`  Market context: BTC ${btc.c[i0].toFixed(0)} -> ${btc.c[i1].toFixed(0)} (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% over the window)`);
  }

  banner('== RUNNING VARIANT BATTERY ==');
  const t0 = Date.now();
  const btcP = bySymbol.get('BTC-USDT');
  const minuteList = [];
  if (btcP) for (let i = btcP.evalStart; i < btcP.n; i++) minuteList.push(btcP.time[i]);
  const align = CFG.portfolioCap > 1 && minuteList.length ? buildAlign(prepared, minuteList) : null;
  if (align) console.log(`  Portfolio replay enabled: cap ${CFG.portfolioCap} slots over ${minuteList.length} minutes`);
  const rows = [];
  let vi = 0;
  for (const v of variants) {
    const variantCfg = { ...CFG, cooldownMin: v.cdMin ?? 0, armAnyExit: !!v.armAnyExit, dailyEntryCap: v.dailyEntryCap || 0 };
    const totals = { trades: [], open: 0 };
    for (const p of prepared) {
      const r = simPerSymbol(p, v, variantCfg);
      for (const t of r.trades) totals.trades.push(t);
      totals.open += r.openAtEnd;
    }
    const stats = summarize(totals.trades, totals.open, v.label, variantCfg);
    let portStats = null;
    if (align) {
      const r = simPortfolio(prepared, v, variantCfg, minuteList, CFG.portfolioCap, align);
      portStats = summarize(r.trades, r.openAtEnd, v.label, variantCfg);
      portStats.maxConcurrent = r.maxConcurrent;
    }
    rows.push({ id: v.id, family: v.family, label: v.label, stats, portStats });
    vi++;
    if (vi % 10 === 0 || vi === variants.length) {
      process.stdout.write(`  ${vi}/${variants.length} variants (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
    }
  }
  console.log(`  Battery completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rankScore = (r) => (r.portStats ? r.portStats.score : r.stats.score);
  const ranked = rows.slice().sort((a, b) => rankScore(b) - rankScore(a));
  printComparison(ranked, CFG.top, CFG.portfolioCap > 1);

  banner('== TOP VARIANT DETAIL ==');
  for (const r of ranked.slice(0, 3)) {
    if (rankScore(r) < 0) break;
    const usePort = CFG.portfolioCap > 1 && r.portStats;
    printDetail(usePort ? r.portStats : r.stats, CFG, r.label + (usePort ? '  [portfolio replay]' : ''));
  }

  // family roll-up — which design school leads?
  banner('== FAMILY ROLL-UP (best variant of each family) ==');
  const bestByFamily = {};
  for (const r of rows) {
    const prev = bestByFamily[r.family];
    if (!prev || rankScore(r) > rankScore(prev)) bestByFamily[r.family] = r;
  }
  const bestFams = Object.entries(bestByFamily).sort((a, b) => rankScore(b[1]) - rankScore(a[1]));
  for (const [fam, r] of bestFams) {
    const s = CFG.portfolioCap > 1 && r.portStats ? r.portStats : r.stats;
    console.log(`  ${fam}: ${pad(r.label.slice(0, 46), 47)} ${padL(s.trades, 6)} trades  WR ${padL(s.winRate.toFixed(1), 5)}%  PF ${padL(s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2), 5)}  net ${padL(fmt$(s.net), 10)}  (H1 ${fmt$(s.h1.net)} / H2 ${fmt$(s.h2.net)})`);
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outFile = path.join(CFG.outDir, `research-${stamp}.json`);
  const statsJson = (s) => s ? {
    trades: s.trades, winRate: +s.winRate.toFixed(2),
    profitFactor: s.profitFactor === Infinity ? null : +s.profitFactor.toFixed(3),
    net: +s.net.toFixed(2), h1: +s.h1.net.toFixed(2), h2: +s.h2.net.toFixed(2),
    h1Trades: s.h1.trades, h2Trades: s.h2.trades,
    score: s.score === -1e9 ? null : +s.score.toFixed(2),
    expectancy: +s.expectancy.toFixed(4), maxDD: +s.maxDD.toFixed(2),
    tradesPerDay: +s.tradesPerDay.toFixed(3), avgHoldMin: +s.avgHoldMin.toFixed(1),
    ...(s.maxConcurrent != null ? { maxConcurrent: s.maxConcurrent } : {}),
    monthly: s.monthly,
    byReason: s.byReason,
    byTag: s.byTag,
  } : null;
  fs.writeFileSync(outFile, JSON.stringify({
    config: { ...CFG, symbols: universe },
    window: { start: WINDOW_START, end: NOW, halfSplit: HALF_SPLIT, days: CFG.days },
    variantCount: variants.length,
    leaderboard: ranked.map(r => ({
      id: r.id, family: r.family, label: r.label,
      perSymbol: statsJson(r.stats),
      portfolio: statsJson(r.portStats),
      symbolBreakdown: r.stats.perSymbol,
      portfolioSymbols: r.portStats ? r.portStats.perSymbol : null,
    })),
    topTrades: ranked.filter(r => rankScore(r) > 0).slice(0, 5).map(r => ({
      id: r.id, label: r.label,
      perSymbol: r.stats.perSymbol,
      portfolioSymbols: r.portStats ? r.portStats.perSymbol : null,
    })),
  }, null, 2));
  console.log(`\nReport saved: ${outFile}`);
}

main().catch(err => { console.error('LAB CRASH:', err); process.exit(1); });
