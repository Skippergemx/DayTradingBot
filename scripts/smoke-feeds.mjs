// Smoke test for src/lib/feeds.js — verifies the Binance multi-host transport
// and every candle plane over the live network (run: npm run smoke:feeds).
import {
  fetchCandles, fetchDayCandles, fetchBtcDaily, fetchDay1h,
  fetchHourlyTrendCandles, fetchBinanceJson, BINANCE_TICKERS_PATH,
} from '../src/lib/feeds.js';

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const [day, day1h, daily, m1, trend] = await Promise.all([
  fetchDayCandles('BTC-USDT'),
  fetchDay1h('BTC-USDT'),
  fetchBtcDaily(),
  fetchCandles('BTC-USDT'),
  fetchHourlyTrendCandles('BTC-USDT'),
]);

check('15m day plane (300 bars)', day.length === 300, `got ${day.length}`);
check('1H day trend plane (1000 bars)', day1h.length === 1000, `got ${day1h.length}`);
check('BTC daily gate (30 bars)', daily.length === 30, `got ${daily.length}`);
check('1m book (200 bars, Binance)', m1.candles.length === 200 && m1.source === 'BINANCE', `source ${m1.source}, got ${m1.candles.length}`);
check('1H advisor tail (50 bars)', Array.isArray(trend) && trend.length === 50, `got ${trend?.length}`);
check('bar shape + ascending order', [day, day1h].every(
  b => b.every(k => Number.isFinite(k.time) && Number.isFinite(k.close)) && b[b.length - 1].time > b[0].time
));

const tickers = await fetchBinanceJson(BINANCE_TICKERS_PATH(['BTC', 'ETH']), 6000);
check('ticker batch transport', Array.isArray(tickers) && tickers.length === 2, `got ${tickers?.length}`);

const skipped = await fetchDayCandles('PRIME-USDT'); // BINANCE_SKIP — must stay []
check('skip-list symbol stays empty', skipped.length === 0, `got ${skipped.length}`);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
