// ── SIGNAL ENGINE (pure) ──────────────────────────────────────────────────────
// The exact math the live scanner runs, extracted so the backtest harness
// (scripts/backtest.mjs) can replay it. Dependency-free on purpose — importable
// from both the browser bundle and Node.

/**
 * Wilder's Smoothed RSI (RMA) — matches TradingView, Binance Charts, MT4 exactly.
 * Uses Wilder's smoothing factor (1/period) instead of simple averages.
 */
export const calculateRSI = (candles, period = 14) => {
  if (!candles || candles.length < period + 2) return 50;

  // Step 1: Seed with simple average of first `period` moves
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Step 2: Wilder's smoothing for all remaining candles
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    // Wilder's: (prev * (n-1) + current) / n
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
};

/** Standard EMA — unchanged, already accurate. */
export const calculateEMA = (candles, period = 20) => {
  if (!candles || candles.length < period) return candles?.[candles.length - 1]?.close || 0;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((acc, c) => acc + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = (candles[i].close * k) + (ema * (1 - k));
  return ema;
};

/**
 * Volume Analysis — compares current volume to 20-candle average.
 * Returns: { ratio: number, trend: 'HIGH' | 'NORMAL' | 'LOW', pressure: number }
 * `nowMs` defaults to the wall clock (live); the backtest passes the bar-close
 * timestamp so the elapsed-fraction normalization runs the same code path.
 */
export const analyzeVolume = (candles, lookback = 20, nowMs = Date.now()) => {
  if (!candles || candles.length < lookback + 1) return { ratio: 1, trend: 'NORMAL', pressure: 50 };

  // Baseline = last `lookback` COMPLETED candles (exclude the live, still-forming candle)
  const completed = candles.slice(-(lookback + 1), -1);
  const avgVol = completed.reduce((acc, c) => acc + (c.volume || 0), 0) / lookback;
  const currentCandle = candles[candles.length - 1];
  const currentVol = currentCandle.volume || 0;

  // The live candle only holds seconds of data, so raw currentVol vs a full-candle
  // average always looks tiny — Buying Pressure could never clear the 60% siege gate.
  // Normalize: compare against the volume expected by this point in the minute.
  const tMs = (currentCandle.time || 0) > 1e12 ? currentCandle.time : (currentCandle.time || 0) * 1000;
  const elapsedMin = tMs > 0 ? (nowMs - tMs) / 60000 : 1;
  const elapsedFraction = Math.min(1, Math.max(0.05, elapsedMin));
  const expectedVol = avgVol * elapsedFraction;
  const ratio = expectedVol > 0 ? currentVol / expectedVol : 1;

  // Buying Pressure: High volume on green candles = Positive Pressure
  const isGreen = currentCandle.close > currentCandle.open;
  const pressure = isGreen ? Math.min(100, 50 + (ratio * 15)) : Math.max(0, 50 - (ratio * 15));

  return {
    ratio: parseFloat(ratio.toFixed(2)),
    trend: ratio > 2.0 ? 'ULTRA' : ratio > 1.5 ? 'HIGH' : ratio < 0.5 ? 'LOW' : 'NORMAL',
    pressure: Math.floor(pressure)
  };
};

/**
 * Scalp score — the dip-buy-biased ranking used by the scanner table.
 * Rewards oversold RSI and price at/below EMA20.
 */
export const computeScalpScore = (rsi, emaDistPct) => Math.max(10, Math.min(100, Math.floor(
  (rsi < 55 ? (55 - rsi) * 2 : 0) + (emaDistPct > -0.05 ? (emaDistPct + 0.05) * 120 : 0)
)));

/**
 * 1H trend context computed from hourly candles (mirrors fetchHourlyTrend).
 * Returns { direction, rsi, emaDist, swingHigh, swingLow, ema20 } or null.
 */
export const computeHourlyTrend = (hourlyCandles) => {
  if (!hourlyCandles || hourlyCandles.length < 22) return null;

  const ema20 = calculateEMA(hourlyCandles, 20);
  if (!ema20) return null;
  const rsi = calculateRSI(hourlyCandles, 14);
  const currentPrice = hourlyCandles[hourlyCandles.length - 1].close;
  const emaDist = ((ema20 - currentPrice) / ema20) * 100;

  // Swing high/low from last 20 hourly candles (key S/R)
  const recent20 = hourlyCandles.slice(-20);
  const swingHigh = Math.max(...recent20.map(c => c.high));
  const swingLow = Math.min(...recent20.map(c => c.low));

  const direction = currentPrice > ema20 ? 'BULLISH' : currentPrice < ema20 * 0.995 ? 'BEARISH' : 'NEUTRAL';

  return { direction, rsi, emaDist, swingHigh, swingLow, ema20 };
};

/**
 * Kingdom threat from BTC/ETH 24h change (mirrors App.jsx).
 */
export const computeKingdomThreat = (btcChange, ethChange) => {
  if (!Number.isFinite(btcChange) || !Number.isFinite(ethChange)) return 'PEACE';
  if (btcChange < -3 || ethChange < -5) return 'CATASTROPHE';
  if (btcChange < -1.5 || ethChange < -2) return 'WAR';
  if (btcChange < 0 || ethChange < 0) return 'UNREST';
  return 'PEACE';
};

/**
 * Wilder's Average True Range (ATR) — the volatility yardstick used to size
 * stops and targets so every trade's risk is measured, not guessed.
 */
export const calculateATR = (candles, period = 14) => {
  if (!candles || candles.length < period + 1) return 0;

  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder's smoothing: seed with SMA of the first `period` ranges
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
};

/**
 * Deterministic trade planner — replaces the swing-bracket template that
 * collided with the momentum gate (target = 20h high ≈ entry during spikes).
 *
 *   'swing' (legacy): stop = 20h swing low, target = 20h swing high.
 *   'atr'   (new):    risk  = atrStopMult × ATR, clamped between minStopPct
 *                     (fee-noise floor) and maxStopPct of price; target =
 *                     rrMin × risk, and the recent swing HIGH must leave room
 *                     for the full target or the trade is skipped
 *                     ("room to run" filter — never buy into a ceiling).
 *
 * Returns { entry, stop, target } or null when the trade is not worth taking.
 */
export const planTrade = ({
  price, atr, swingHigh = 0, swingLow = 0,
  strategy = 'atr', rrMin = 1.5, atrStopMult = 1.0,
  minStopPct = 0, maxStopPct = 0.02,
}) => {
  if (!Number.isFinite(price) || price <= 0) return null;

  if (strategy === 'swing') {
    const stop = swingLow || price * 0.99;
    const target = swingHigh || price * 1.02;
    if (!(target > price) || !(stop < price)) return null;
    return { entry: price, stop, target };
  }

  if (!Number.isFinite(atr) || atr <= 0) return null;
  // Volatility-sized risk, clamped: the floor keeps stops outside fee noise,
  // the cap keeps one trade from risking more than maxStopPct of price.
  const stopDist = Math.min(Math.max(atrStopMult * atr, minStopPct * price), maxStopPct * price);
  if (!(stopDist > 0) || stopDist >= price) return null;
  const targetDist = rrMin * stopDist;

  // Room to run: the 20h swing high must not block the full target
  if (swingHigh && swingHigh - price < targetDist) return null;

  return { entry: price, stop: price - stopDist, target: price + targetDist };
};
