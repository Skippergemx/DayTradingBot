import { useState, useEffect, useRef } from 'react';
import { SYMBOLS, COINGECKO_IDS, BINANCE_MAP, BINANCE_SKIP } from '../lib/universe';
import { calculateRSI, calculateEMA, analyzeVolume, computeScalpScore, computeHourlyTrend } from '../lib/engine';
import { killzoneState } from '../lib/ict';
import {
  CC_KEY, CC_NEWS_URL, CC_NEWS_GLOBAL_URL, SOURCE_COOLDOWN_MS,
  fetchWithTimeout, isSourceDead, markSource, fetchBinanceJson, BINANCE_TICKERS_PATH,
  fetchCandles, fetchDayCandles, fetchBtcDaily, fetchDay1h, fetchHourlyTrendCandles,
} from '../lib/feeds';

// ── PRICE-LAYER SOURCES ───────────────────────────────────────────────────────
// Candle/ticker transport (Binance multi-host + CryptoCompare backup) lives in
// ../lib/feeds — this hook owns state, scheduling and the price layers below.
const SOURCES = {
  COINGECKO_SIMPLE: (ids) =>
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
};
const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const COINGECKO_TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
const GLOBAL_TTL_MS = 30 * 60 * 1000;    // macro gravity + retail heat cadence

// ── REFRESH TTLs — how stale each plane may get before its next rotation step ─
const DAY_TTL_MS = 3 * 60 * 1000;        // day desks read the just-closed 15m bucket — land it fast
const DAY_1H_TTL_MS = 10 * 60 * 1000;    // converged 1H day plane — hours change hourly
const BTC_DAILY_TTL_MS = 10 * 60 * 1000; // one tiny daily-regime request for the whole board

const formatPrice = (n, symbol) => n < 0.1 ? n.toFixed(6) : n.toFixed(symbol.includes('BTC') ? 1 : 4);

// ── MAIN HOOK ─────────────────────────────────────────────────────────────────
export const useMarketFeed = () => {
  const [marketData, setMarketData] = useState([]);
  const [signals] = useState([]);
  const [status, setStatus] = useState('CONNECTING');
  const [candleSource, setCandleSource] = useState('DETECTING...');
  const [priceSource, setPriceSource] = useState('SYNCING');
  const [selectedSymbol, setSelectedSymbol] = useState('BTC-USDT');
  const [candles, setCandles] = useState([]);
  const [news, setNews] = useState([]);
  const [fundamentals, setFundamentals] = useState(null);
  const [fearGreed, setFearGreed] = useState(null);
  const [globalStats, setGlobalStats] = useState(null);
  const [trending, setTrending] = useState([]);
  const [hourlyTrend, setHourlyTrend] = useState(null); // 1H trend filter
  const [timeframe, setTimeframe] = useState('1m');
  const [diagnostics, setDiagnostics] = useState({ scans: 0, errors: 0, lastAsset: 'NONE', lastAlpha: 0, lastCalc: 'WAITING' });
  // Per-symbol candle tails for the ICT state machine (symbol → last ~160 bars).
  // The machine needs structure history for EVERY desk it might rank, not just
  // the charted one — this is the decoupled data plane the telemetry renders from.
  const [candleBook, setCandleBook] = useState({});
  // Day data plane: per-symbol 300×15M tails (lib/daydesk.js) + BTC 30×1D for
  // the daily regime gates every day desk reads, plus a per-symbol 1000×1H
  // trend tail so the day desks' EMA100/50 and 4H-EMA20 are fully converged.
  const [dayBook, setDayBook] = useState({});
  const [day1hBook, setDay1hBook] = useState({});
  const [btcDaily, setBtcDaily] = useState([]);

  const pricesRef = useRef(SYMBOLS.reduce((acc, s) => {
    acc[s] = { symbol: s, price: '0.00', change: '0.00', volume: '0', strength: 50, scalpScore: 10, status: 'WAITING', hasActiveSignal: false, rsi: 50, emaDist: 0 };
    return acc;
  }, {}));
  const scanIdxRef = useRef(0);
  const dayIdxRef = useRef(0);
  const dayFetchedAtRef = useRef({});
  const day1hFetchedAtRef = useRef({});
  const btcDailyFetchedAtRef = useRef(0);
  const globalFetchedAtRef = useRef(0);
  const trendingFetchedAtRef = useRef(0);
  const globalStatsRef = useRef(null);
  const trendingRef = useRef([]);
  const cycleBusyRef = useRef(false);
  const cycleCountRef = useRef(1); // first ++ lands on 2 → prices fetch immediately on boot
  const cgTickRef = useRef(0);     // counts price refreshes — CoinGecko's cadence runs off this

  // ── 1H Trend Filter (every 15 min) ──────────────────────────────────────────
  const fetchHourlyTrend = async (symbol) => {
    try {
      // Binance multi-host → CryptoCompare (keyed) → null, decided in lib/feeds
      const hourlyCandles = await fetchHourlyTrendCandles(symbol);
      if (!hourlyCandles || hourlyCandles.length < 22) return;

      // --- SYMBOL INTEGRITY GUARD ---
      if (symbol !== selectedSymbol) return;

      const trend = computeHourlyTrend(hourlyCandles);
      if (!trend) return;

      setHourlyTrend({
        symbol: symbol, // DNA Stamp
        direction: trend.direction,
        rsi: trend.rsi,
        emaDist: trend.emaDist,
        swingHigh: trend.swingHigh.toFixed(4),
        swingLow: trend.swingLow.toFixed(4),
        ema20: trend.ema20.toFixed(4),
      });
    } catch { /* trend fetch failed — keep the last known trend; next cycle retries */ }
  };

  // ── Fear & Greed (every 30 min) ──────────────────────────────────────────────
  const fetchFearGreed = async () => {
    try {
      const res = await fetchWithTimeout(FEAR_GREED_URL, 6000);
      const json = await res.json();
      if (json.data?.[0]) setFearGreed({ value: json.data[0].value, label: json.data[0].value_classification });
    } catch { /* F&G fetch failed — keep the last reading; next cycle retries */ }
  };

  // ── Global pulse (every 30 min) — keyless CoinGecko /global ────────────────
  const fetchGlobalStats = async () => {
    try {
      const res = await fetchWithTimeout(COINGECKO_GLOBAL_URL, 6000);
      if (!res.ok) throw new Error(`global ${res.status}`);
      const json = await res.json();
      const d = json.data;
      if (!d) return;
      const stats = {
        totalMcap: d.total_market_cap?.usd,
        mcapChange24h: d.market_cap_change_percentage_24h_usd,
        btcDominance: d.market_cap_percentage?.btc,
        ethDominance: d.market_cap_percentage?.eth,
      };
      globalStatsRef.current = stats;
      setGlobalStats(stats);
    } catch { /* macro layer fetch failed — retry in ~1 min, keep the last reading */
      globalFetchedAtRef.current = Date.now() - GLOBAL_TTL_MS + 60000;
    }
  };

  // ── Retail heat (every 30 min) — keyless CoinGecko trending search ────────
  const fetchTrending = async () => {
    try {
      const res = await fetchWithTimeout(COINGECKO_TRENDING_URL, 6000);
      if (!res.ok) throw new Error(`trending ${res.status}`);
      const json = await res.json();
      const list = (json.coins || []).slice(0, 7).map(c => ({
        id: c.item?.id,
        symbol: (c.item?.symbol || '').toUpperCase(),
        name: c.item?.name,
        rank: c.item?.market_cap_rank,
        change24h: c.item?.data?.price_change_percentage_24h?.usd,
      })).filter(c => c.symbol);
      if (list.length) {
        trendingRef.current = list;
        setTrending(list);
      }
    } catch { /* trending failed — retry in ~1 min, keep the last list */
      trendingFetchedAtRef.current = Date.now() - GLOBAL_TTL_MS + 60000;
    }
  };

  // ── CoinGecko Fundamentals (every 10 min) ────────────────────────────────────
  const fetchFundamentals = async (symbol) => {
    const base = symbol.split('-')[0];
    const id = COINGECKO_IDS[base];
    if (!id) return;
    try {
      const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`, 6000);
      const json = await res.json();
      setFundamentals({
        marketCap: json.market_data?.market_cap?.usd,
        rank: json.market_cap_rank,
        circulating: json.market_data?.circulating_supply,
        maxSupply: json.market_data?.max_supply,
        change7d: json.market_data?.price_change_percentage_7d,
        change30d: json.market_data?.price_change_percentage_30d,
        ath: json.market_data?.ath?.usd,
        athChange: json.market_data?.ath_change_percentage?.usd,
        description: json.description?.en?.slice(0, 200),
      });
    } catch { /* fundamentals fetch failed — keep the last snapshot; next cycle retries */ }
  };

  // ── News ─────────────────────────────────────────────────────────────────────
  // Vio8 synthesizes her own intel from price action when the wire is unavailable
  const buildSyntheticNews = (symbol) => {
    const live = pricesRef.current[symbol] || {};
    const price = parseFloat(live.price);
    // Every symbol seeds as '0.00' until its first tick lands — never quote the seed
    const rich = Number.isFinite(price) && price > 0;
    const items = [
      { id: 'v8-1', title: rich
        ? `[VIO8 INTEL] Structural volatility for ${symbol} detected at $${live.price}.`
        : `[VIO8 INTEL] Structural volatility scan underway for ${symbol}.`, source: 'VIO8_ORACLE', time: Date.now()/1000 },
      { id: 'v8-2', title: rich
        ? `[VIO8 INTEL] Kingdom gravity for ${symbol} shifted ${live.change}% in 24h cycle.`
        : `[VIO8 INTEL] Kingdom gravity for ${symbol} recalibrating against the live tape.`, source: 'VIO8_ORACLE', time: Date.now()/1000 - 300 },
      { id: 'v8-3', title: `[VIO8 INTEL] Analyzing order flow delta for high-conviction scalp entries.`, source: 'VIO8_ORACLE', time: Date.now()/1000 - 600 }
    ];
    // Macro + retail lines keep the synthetic wire grounded in real keyless data
    const g = globalStatsRef.current;
    if (g && Number.isFinite(Number(g.totalMcap)) && Number.isFinite(Number(g.btcDominance))) {
      const cap = Number(g.totalMcap);
      const capTxt = cap >= 1e12 ? `$${(cap / 1e12).toFixed(2)}T` : `$${(cap / 1e9).toFixed(0)}B`;
      const chg = Number(g.mcapChange24h);
      items.push({
        id: 'v8-4',
        title: `[VIO8 INTEL] Global cap ${capTxt}${Number.isFinite(chg) ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% 24h)` : ''} · BTC dominance ${Number(g.btcDominance).toFixed(1)}% — macro gravity read.`,
        source: 'VIO8_ORACLE', time: Date.now()/1000 - 900,
      });
    }
    const trend = trendingRef.current;
    if (Array.isArray(trend) && trend.length) {
      items.push({
        id: 'v8-5',
        title: `[VIO8 INTEL] Retail heat rotating through ${trend.slice(0, 4).map(t => t.symbol).join(', ')} — search flows leading the tape.`,
        source: 'VIO8_ORACLE', time: Date.now()/1000 - 1200,
      });
    }
    return items;
  };

  const fetchNews = async (symbol) => {
    // CryptoCompare news requires a key now — render synthetic Vio8 intel otherwise
    if (!CC_KEY || isSourceDead('CC_NEWS')) { setNews(buildSyntheticNews(symbol)); return; }
    try {
      const base = symbol.split('-')[0];
      // Try specific token news first
      const res = await fetchWithTimeout(CC_NEWS_URL(base), 5000);
      if (!res.ok) throw new Error(`news wire ${res.status}`);
      const json = await res.json();
      
      let newsData = json.Data || [];
      
      // ABSOLUTE FALLBACK: If no news for token, pull GLOBAL LATEST news (Guaranteed)
      if (newsData.length === 0) {
        const fallRes = await fetchWithTimeout(CC_NEWS_GLOBAL_URL(), 5000);
        const fallJson = await fallRes.json();
        newsData = fallJson.Data || [];
      }

      if (newsData.length > 0) {
        markSource('CC_NEWS', true);
        setNews(newsData.slice(0, 8).map(n => ({ id: n.id, title: n.title, url: n.url, source: n.source, time: n.published_on })));
      } else {
        setNews(buildSyntheticNews(symbol));
      }
    } catch (err) {
      console.error("News wire interference:", err);
      markSource('CC_NEWS', false);
      setNews(buildSyntheticNews(symbol));
    }
  };

  // ── Master Cycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let masterTimer, uiTimer, fgTimer, fundTimer, newsTimer;

    // --- CONTEXT PURGE ---
    // Wipe structure/fundamentals but KEEP news/candles until fresh data arrives.
    // Deliberate symbol-switch purge — stale context must never render against a new asset.
    /* eslint-disable react-hooks/set-state-in-effect */
    setHourlyTrend(null);
    setFundamentals(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // REMOVED setNews([]); 
    // REMOVED setCandles([]);

    // ── PRICE LAYER 1: Binance batch tickers — one request covers every mapped pair ──
    const fetchPricesBinance = async () => {
      const binBases = [...new Set(SYMBOLS
        .map(s => s.split('-')[0])
        .filter(b => !BINANCE_SKIP.includes(b))
        .map(b => BINANCE_MAP[b] || b))];
      const data = await fetchBinanceJson(BINANCE_TICKERS_PATH(binBases), 6000);
      if (!data) throw new Error('ticker transport: every host failed');
      const byBase = {};
      data.forEach(t => { byBase[t.symbol.slice(0, -4)] = t; });
      SYMBOLS.forEach(s => {
        const t = byBase[BINANCE_MAP[s.split('-')[0]] || s.split('-')[0]];
        if (!t) return;
        const changePct = parseFloat(t.priceChangePercent);
        pricesRef.current[s] = {
          ...pricesRef.current[s],
          price: formatPrice(parseFloat(t.lastPrice), s),
          change: changePct.toFixed(2),
          volume: (parseFloat(t.quoteVolume) / 1000).toFixed(0) + 'K',
          dayHigh: parseFloat(t.highPrice), dayLow: parseFloat(t.lowPrice),
          strength: Math.min(100, Math.floor(Math.abs(changePct) * 10 + 50)),
        };
      });
    };

    // ── PRICE LAYER 2: CoinGecko — covers all symbols natively; sole source if Binance is blocked ──
    // Accepts an explicit id list: a top-up subset while Binance is healthy,
    // or the full board when CoinGecko has to carry the scanner alone.
    const fetchPricesCoinGecko = async (idsOverride = null) => {
      const ids = idsOverride || [...new Set(SYMBOLS.map(s => COINGECKO_IDS[s.split('-')[0]]).filter(Boolean))];
      const res = await fetchWithTimeout(SOURCES.COINGECKO_SIMPLE(ids), 8000);
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const json = await res.json();
      SYMBOLS.forEach(s => {
        const d = json[COINGECKO_IDS[s.split('-')[0]]];
        if (!d || typeof d.usd !== 'number') return;
        const changePct = typeof d.usd_24h_change === 'number' ? d.usd_24h_change : 0;
        pricesRef.current[s] = {
          ...pricesRef.current[s],
          price: formatPrice(d.usd, s),
          change: changePct.toFixed(2),
          volume: typeof d.usd_24h_vol === 'number' ? (d.usd_24h_vol / 1000).toFixed(0) + 'K' : pricesRef.current[s].volume,
          strength: Math.min(100, Math.floor(Math.abs(changePct) * 10 + 50)),
        };
      });
    };

    const fetchPrices = async () => {
      let source = null;
      if (!isSourceDead('BINANCE_BATCH')) {
        try { await fetchPricesBinance(); markSource('BINANCE_BATCH', true); source = 'BINANCE'; }
        catch { markSource('BINANCE_BATCH', false); }
      }
      if (!isSourceDead('COINGECKO_PRICE')) {
        const binanceOk = source === 'BINANCE';
        cgTickRef.current += 1;
        // CoinGecko's keyless tier 429s easily — and its error response omits CORS
        // headers, so Chrome also reports a bogus "blocked by CORS" for the 429.
        // Binance healthy → top up only the pairs it can't price (currently none,
        // so the call is skipped entirely and the rate budget stays untouched).
        // Binance down → full board every ~12s so the scanner keeps moving.
        const due = binanceOk ? cgTickRef.current % 5 === 1 : cgTickRef.current % 2 === 1;
        if (due) {
          try {
            const topUpIds = BINANCE_SKIP.map(b => COINGECKO_IDS[b]).filter(Boolean);
            if (!binanceOk || topUpIds.length) {
              await fetchPricesCoinGecko(binanceOk ? topUpIds : null);
              markSource('COINGECKO_PRICE', true);
              if (!binanceOk) source = 'COINGECKO';
            }
          } catch (err) {
            const rateLimited = String(err?.message || '').includes('429');
            markSource('COINGECKO_PRICE', false, rateLimited ? 10 * 60 * 1000 : SOURCE_COOLDOWN_MS);
          }
        }
      }
      if (source) { setPriceSource(source); setStatus('LIVE'); }
      else setStatus('RESTRICTED');
    };

    const runPriceCycle = async () => {
      // Overlap guard — a slow source must not stack cycles on top of each other
      if (cycleBusyRef.current) return;
      cycleBusyRef.current = true;
      try {
        // Prices refresh every other cycle (~6s); CoinGecko layers on top only when due
        cycleCountRef.current += 1;
        if (cycleCountRef.current % 2 === 0) await fetchPrices();

        // Batch scan 4 assets per cycle — the full 50-symbol sweep lands in ≈37s
        for (let i = 0; i < 4; i++) {
          const symbol = SYMBOLS[scanIdxRef.current];
          try {
            const { candles: raw, source } = await fetchCandles(symbol);
            if (source !== 'OFFLINE' && source !== 'NO PAIR') setCandleSource(source);
            if (symbol === selectedSymbol) setCandles(raw);

            // Feed the ICT structure book — skip the state write when the last
            // candle hasn't changed (same bar re-fetched), keeps renders quiet.
            if (raw.length) {
              setCandleBook(prev => {
                const tail = prev[symbol];
                if (tail && tail[tail.length - 1]?.time === raw[raw.length - 1].time) return prev;
                return { ...prev, [symbol]: raw.slice(-160) };
              });
            }

            const rsi = calculateRSI(raw);       // Wilder's RMA — matches TradingView
            const ema = calculateEMA(raw, 20);    // Standard EMA
            const vol = analyzeVolume(raw);        // Volume context
            const price = raw[raw.length - 1]?.close || 0;
            const dist = price ? ((ema - price) / ema) * 100 : 0;
            const score = computeScalpScore(rsi, dist);

            pricesRef.current[symbol] = {
              ...pricesRef.current[symbol],
              scalpScore: score,
              rsi, emaDist: dist,
              volumeTrend: vol.trend,
              volumeRatio: vol.ratio,
              volumePressure: vol.pressure
            };
            setDiagnostics(d => ({ ...d, scans: d.scans + 1, lastAsset: symbol, lastCalc: `[${source}] RSI: ${rsi.toFixed(1)} | VOL: ${vol.trend} (${vol.pressure}%)` }));
          } catch { setDiagnostics(d => ({ ...d, errors: d.errors + 1 })); }
          scanIdxRef.current = (scanIdxRef.current + 1) % SYMBOLS.length;
        }

        // ── DAY LAYER: one 15m refresh per cycle, staggered over the board ──
        // A 3-minute TTL: the day desks read the just-CLOSED bucket, so its
        // final print must land quickly.
        const daySymbol = SYMBOLS[dayIdxRef.current];
        dayIdxRef.current = (dayIdxRef.current + 1) % SYMBOLS.length;
        if ((dayFetchedAtRef.current[daySymbol] || 0) < Date.now() - DAY_TTL_MS) {
          dayFetchedAtRef.current[daySymbol] = Date.now(); // stamp first — no double-fetch on slow responses
          const dayBars = await fetchDayCandles(daySymbol);
          if (dayBars.length) {
            setDayBook(prev => {
              // Skip only when the newest bucket is unchanged — a completed
              // bucket keeps its timestamp while its content turns final, and
              // the fetch that follows its close carries the NEXT forming
              // bucket as the tail, so the transition always writes.
              const tail = prev[daySymbol];
              if (tail && tail[tail.length - 1]?.time === dayBars[dayBars.length - 1].time) return prev;
              return { ...prev, [daySymbol]: dayBars };
            });
          } else {
            dayFetchedAtRef.current[daySymbol] = 0; // failed — retry on the next rotation
          }
        }
        // ── DAY TREND PLANE: one 1000×1H refresh per cycle, same stagger ──
        // Hours only change every hour — a 10-minute TTL keeps the day desks'
        // EMA100/50 + 4H-EMA20 gates within minutes of the tape while staying
        // fully converged.
        if ((day1hFetchedAtRef.current[daySymbol] || 0) < Date.now() - DAY_1H_TTL_MS) {
          day1hFetchedAtRef.current[daySymbol] = Date.now();
          const trendBars = await fetchDay1h(daySymbol);
          if (trendBars.length) {
            setDay1hBook(prev => {
              const tail = prev[daySymbol];
              if (tail && tail[tail.length - 1]?.time === trendBars[trendBars.length - 1].time) return prev;
              return { ...prev, [daySymbol]: trendBars };
            });
          } else {
            day1hFetchedAtRef.current[daySymbol] = 0; // failed — retry on the next rotation
          }
        }

        // ── BTC DAILY: the regime gate refreshes once per 10 minutes ──
        if (btcDailyFetchedAtRef.current < Date.now() - BTC_DAILY_TTL_MS) {
          btcDailyFetchedAtRef.current = Date.now();
          const d = await fetchBtcDaily();
          if (d.length) setBtcDaily(d);
          else btcDailyFetchedAtRef.current = 0; // failed — retry on the next cycle
        }

        // ── GLOBAL PULSE / RETAIL HEAT — keyless CoinGecko, 30-min TTL ──
        // Fire-and-forget: a slow macro call must never stall the scan rotation.
        if (globalFetchedAtRef.current < Date.now() - GLOBAL_TTL_MS) {
          globalFetchedAtRef.current = Date.now(); // stamp first — no double-fetch on slow responses
          fetchGlobalStats();
        }
        if (trendingFetchedAtRef.current < Date.now() - GLOBAL_TTL_MS) {
          trendingFetchedAtRef.current = Date.now();
          fetchTrending();
        }
      } finally {
        cycleBusyRef.current = false;
      }
    };

    // Boot sequence
    fetchFearGreed();
    fetchGlobalStats();
    fetchTrending();
    fetchFundamentals(selectedSymbol);
    fetchNews(selectedSymbol);
    fetchHourlyTrend(selectedSymbol); // 1H Trend Filter

    // Warm the day planes — the day desks need their own symbol's 15m book
    // plus the BTC daily regime before they can arm anything.
    fetchDayCandles(selectedSymbol).then(bars => {
      if (bars.length) {
        setDayBook(prev => ({ ...prev, [selectedSymbol]: bars }));
        dayFetchedAtRef.current[selectedSymbol] = Date.now();
      }
    });
    fetchBtcDaily().then(d => {
      if (d.length) { setBtcDaily(d); btcDailyFetchedAtRef.current = Date.now(); }
    });
    // ...and the converged 1H trend tails: BTC first (the whole board's regime
    // gate), then the charted symbol for instant evaluation.
    fetchDay1h('BTC-USDT').then(bars => {
      if (bars.length) {
        setDay1hBook(prev => ({ ...prev, 'BTC-USDT': bars }));
        day1hFetchedAtRef.current['BTC-USDT'] = Date.now();
      }
    });
    fetchDay1h(selectedSymbol).then(bars => {
      if (bars.length) {
        setDay1hBook(prev => ({ ...prev, [selectedSymbol]: bars }));
        day1hFetchedAtRef.current[selectedSymbol] = Date.now();
      }
    });
    // The boot news build above ran before prices landed (it would quote the
    // '0.00' seed) — rebuild the synthetic intel once the first cycle is in.
    runPriceCycle().then(() => { if (!CC_KEY || isSourceDead('CC_NEWS')) fetchNews(selectedSymbol); });

    uiTimer = setInterval(() => setMarketData(Object.values(pricesRef.current).sort((a, b) => b.scalpScore - a.scalpScore)), 1500);
    masterTimer = setInterval(runPriceCycle, 3000);
    fgTimer = setInterval(fetchFearGreed, 30 * 60 * 1000);
    fundTimer = setInterval(() => fetchFundamentals(selectedSymbol), 10 * 60 * 1000);
    newsTimer = setInterval(() => fetchNews(selectedSymbol), 5 * 60 * 1000);
    const hourlyTimer = setInterval(() => fetchHourlyTrend(selectedSymbol), 15 * 60 * 1000);

    return () => [masterTimer, uiTimer, fgTimer, fundTimer, newsTimer, hourlyTimer].forEach(clearInterval);
  }, [selectedSymbol]);

  // Real ICT killzone status — Silver Bullet windows on New York wall time.
  // Supersedes the old whole-hour check; delegates to lib/ict.js so the window
  // definition lives in exactly one place.
  const getSbStatus = () => {
    // Call-time wall-clock read for display-only killzone labels — refreshed on every render tick.
    // eslint-disable-next-line react-hooks/purity -- display-only label, no state derived from it
    const kz = killzoneState(Date.now());
    return {
      active: kz.active,
      session: kz.active ? kz.id : 'WAITING',
      label: kz.label,
      next: kz.next,
      minutesLeft: kz.minutesLeft,
    };
  };

  return {
    marketData, signals, status, candleSource, priceSource,
    selectedSymbol, setSelectedSymbol,
    candles, candleBook, dayBook, day1hBook, btcDaily, news, fundamentals, fearGreed, hourlyTrend,
    globalStats, trending,
    timeframe, setTimeframe,
    sbStatus: getSbStatus(),
    diagnostics
  };
};
