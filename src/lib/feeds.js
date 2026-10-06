// ── DATA FEEDS — pure, Node-importable ────────────────────────────────────────
// The whole network transport lives here: Binance klines/tickers over a primary
// host + CORS-open mirror edges, CryptoCompare last-resort (key-gated), plus the
// source-health registry shared with the price/news layers in useMarketFeed.
import { BINANCE_MAP, BINANCE_SKIP } from './universe.js';

// CryptoCompare now rejects keyless requests (HTTP 401, which browsers surface
// as a CORS error). Optional key via .env.local:  VITE_CC_API_KEY=your_key
export const CC_KEY = (import.meta.env && import.meta.env.VITE_CC_API_KEY) || '';
const withCCKey = (url) => CC_KEY ? `${url}${url.includes('?') ? '&' : '?'}api_key=${CC_KEY}` : url;

export const CC_NEWS_URL = (category) =>
  withCCKey(`https://min-api.cryptocompare.com/data/v2/news/?limit=10&categories=${category}`);
export const CC_NEWS_GLOBAL_URL = () =>
  withCCKey('https://min-api.cryptocompare.com/data/v2/news/?limit=10');

// Failing sources get a cooldown so dead paths don't pay repeated timeouts.
// One shared registry — candles and the hook's price/news layers use the same.
export const SOURCE_COOLDOWN_MS = 5 * 60 * 1000;
const sourceDeadUntil = {};
const srcFails = {};
export const isSourceDead = (key) => (sourceDeadUntil[key] || 0) > Date.now();
export const markSource = (key, ok, cooldownMs = SOURCE_COOLDOWN_MS) => {
  if (ok) { delete sourceDeadUntil[key]; delete srcFails[key]; return; }
  srcFails[key] = (srcFails[key] || 0) + 1;
  if (srcFails[key] >= 2) sourceDeadUntil[key] = Date.now() + cooldownMs;
};

// ── FETCH WITH TIMEOUT ────────────────────────────────────────────────────────
export const fetchWithTimeout = (url, ms = 4000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
};

// ── BINANCE TRANSPORT (primary + mirror edges) ────────────────────────────────
// api.binance.com is the primary market-data edge. data-api.binance.vision and
// the numbered edges (api1-3) serve the SAME API over independent routes — all
// verified CORS-open and keyless. A dead or geo-blocked host degrades to the
// next instead of starving the desks; when EVERY host fails at the network
// level the transport fast-fails for a minute so an outage never burns a
// timeout on every rotation step.
const HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];
let lastGoodHost = 0;
let transportDeadUntil = 0;

export const fetchBinanceJson = async (path, timeoutMs) => {
  if (Date.now() < transportDeadUntil) return null;
  for (let i = 0; i < HOSTS.length; i++) {
    const idx = (lastGoodHost + i) % HOSTS.length;
    try {
      // The first attempt gets the full timeout; when the leading host is
      // unreachable the mirrors are usually down the same way — probe them fast.
      const res = await fetchWithTimeout(`${HOSTS[idx]}${path}`, i === 0 ? timeoutMs : Math.min(timeoutMs, 3000));
      if (res.ok) {
        const json = await res.json();
        lastGoodHost = idx; // stay on the edge that just worked
        return json;
      }
      // 451/403 = this edge is blocking us (geo/edge policy) — try the next one.
      if (res.status === 451 || res.status === 403) continue;
      // Any other non-OK status means the edge IS alive and the request itself
      // failed (bad symbol, throttle…) — fail just this call, not the transport.
      return null;
    } catch { /* host unreachable — try the next edge */ }
  }
  transportDeadUntil = Date.now() + 60 * 1000;
  return null;
};

export const BINANCE_TICKERS_PATH = (binBases) =>
  `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(binBases.map(b => b + 'USDT')))}`;

const fetchKlines = async (binBase, interval, limit, timeoutMs) => {
  const data = await fetchBinanceJson(`/api/v3/klines?symbol=${binBase}USDT&interval=${interval}&limit=${limit}`, timeoutMs);
  if (!Array.isArray(data) || data.length === 0) return [];
  return data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
};

// ── CANDLE PLANES ─────────────────────────────────────────────────────────────
// Sized per desk: 1m scalp book (200), 15m day compression (300 ≈ 75h), and the
// 1000×1H day trend plane whose length drives the EMA100/50 + 4H EMA20 seed
// residual below float noise (a shorter book left ~2–6% residual — the
// port-fidelity harness caught 3 flipped gate minutes in 50 days; 1000 bars is
// Binance's single-call limit).
const DAY_BARS = 300;
const DAY_1H_BARS = 1000;

// 1m scalp book: Binance transport → CryptoCompare (keyed) → offline
export const fetchCandles = async (symbol) => {
  const base = symbol.split('-')[0];
  if (BINANCE_SKIP.includes(base) && !CC_KEY) return { candles: [], source: 'NO PAIR' };
  if (!BINANCE_SKIP.includes(base)) {
    const bars = await fetchKlines(BINANCE_MAP[base] || base, '1m', 200, 5000);
    if (bars.length) return { candles: bars, source: 'BINANCE' };
  }

  // LAST RESORT: CryptoCompare — requires an API key (keyless requests get 401)
  if (CC_KEY && !isSourceDead('CRYPTOCOMPARE')) {
    try {
      const res = await fetchWithTimeout(withCCKey(`https://min-api.cryptocompare.com/data/v2/histoMinute?fsym=${base}&tsym=USDT&limit=200`), 5000);
      if (res.ok) {
        const json = await res.json();
        markSource('CRYPTOCOMPARE', true);
        return {
          candles: (json.Data?.Data || []).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumeto })),
          source: 'CRYPTOCOMPARE'
        };
      }
      markSource('CRYPTOCOMPARE', false);
    } catch { markSource('CRYPTOCOMPARE', false); }
  }

  return { candles: [], source: BINANCE_SKIP.includes(base) ? 'NO PAIR' : 'OFFLINE' };
};

// Day compression plane: 300×15M — the day desks read the last COMPLETED bucket
// only; Wilder ATR(14), RSI(2) and the SMA20 volume average are fully converged.
export const fetchDayCandles = async (symbol) => {
  const base = symbol.split('-')[0];
  if (BINANCE_SKIP.includes(base)) return [];
  return fetchKlines(BINANCE_MAP[base] || base, '15m', DAY_BARS, 6000);
};

// BTC daily regime gate: 30×1D — the gate readers drop the forming day.
export const fetchBtcDaily = async () =>
  fetchKlines(BINANCE_MAP['BTC'] || 'BTC', '1d', 30, 6000);

// Day trend plane: 1000×1H (see the CANDLE PLANES note above).
export const fetchDay1h = async (symbol) => {
  const base = symbol.split('-')[0];
  if (BINANCE_SKIP.includes(base)) return [];
  return fetchKlines(BINANCE_MAP[base] || base, '1h', DAY_1H_BARS, 9000);
};

// 1H trend tail (50 bars) for the advisor's context panel — Binance → CC → null
export const fetchHourlyTrendCandles = async (symbol) => {
  const base = symbol.split('-')[0];
  if (!BINANCE_SKIP.includes(base)) {
    const bars = await fetchKlines(BINANCE_MAP[base] || base, '1h', 50, 5000);
    if (bars.length) return bars;
  }
  if (CC_KEY && !isSourceDead('CRYPTOCOMPARE')) {
    try {
      const res = await fetchWithTimeout(withCCKey(`https://min-api.cryptocompare.com/data/v2/histohour?fsym=${base}&tsym=USDT&limit=50`), 5000);
      if (res.ok) {
        const json = await res.json();
        markSource('CRYPTOCOMPARE', true);
        return (json.Data?.Data || []).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close }));
      }
      markSource('CRYPTOCOMPARE', false);
    } catch { markSource('CRYPTOCOMPARE', false); }
  }
  return null;
};
