import { useEffect, useMemo, useState } from 'react';
import { Activity, Cpu, Database, Newspaper, ShieldCheck, Flame } from 'lucide-react';
import { cn } from '../lib/utils';
import { SYMBOLS } from '../lib/universe';
import { SCREEN_VERSION, SHARIA_CRITERIA, EXCLUDED, EXCLUDED_BASES, screenStatus } from '../lib/compliance';

const CATEGORY_TABS = ['ALL', 'CORE', 'GAMING', 'AI'];
const PULSE = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT'];

const fmtUsd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
};

// Unit counts (supply) — same suffixes, no currency mark.
const fmtNum = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
};

const SORT_COLUMNS = [
  { key: 'scalpScore', label: 'Scalp' },
  { key: 'change', label: '24H' },
  { key: 'rsi', label: 'RSI' },
];

export const IntelTab = ({
  filteredCoins,
  marketData,
  selectedSymbol,
  handleSelectSymbol,
  activeCategory,
  setActiveCategory,
  news,
  fundamentals,
  fearGreed,
  globalStats,
  trending,
  diagnostics,
  showDevMode,
  status,
  candleSource,
  priceSource,
}) => {
  const [sortKey, setSortKey] = useState('scalpScore');
  const [sortDir, setSortDir] = useState('desc');
  const [screenOpen, setScreenOpen] = useState(false);
  // Wall-clock for the news wire's relative timestamps — read on a slow tick
  // instead of during render (impure Date.now() in render is flagged by lint).
  const [nowSec, setNowSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60000);
    return () => clearInterval(t);
  }, []);

  const onSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = useMemo(() => {
    const val = (c) => {
      if (sortKey === 'change') return parseFloat(c.change) || 0;
      if (sortKey === 'rsi') return Number(c.rsi) || 0;
      return Number(c.scalpScore) || 0;
    };
    const list = [...filteredCoins].sort((a, b) => val(b) - val(a));
    return sortDir === 'desc' ? list : list.reverse();
  }, [filteredCoins, sortKey, sortDir]);

  const pulse = useMemo(
    () => PULSE.map(sym => marketData.find(m => m.symbol === sym)).filter(Boolean),
    [marketData]
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden custom-scrollbar">
      <div className="grid gap-3 lg:grid-cols-12 lg:h-full">
        {/* ── Board column ─────────────────────────────────────────────────── */}
        <section className="lg:col-span-8 flex flex-col gap-3 lg:min-h-0">
          {/* Market pulse */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 shrink-0">
            {pulse.map(coin => (
              <button
                key={coin.symbol}
                onClick={() => handleSelectSymbol(coin.symbol)}
                className="panel px-3 py-2 text-left hover:border-cyan-neon/25 transition-all"
              >
                <div className="text-[11px] font-black uppercase tracking-widest text-white/45">{coin.symbol.split('-')[0]}</div>
                <div className="text-[14px] font-black font-mono text-white leading-tight">{coin.price}</div>
                <div className={cn(
                  'text-[12px] font-mono font-bold',
                  parseFloat(coin.change) >= 0 ? 'text-green-400' : 'text-red-400'
                )}>
                  {parseFloat(coin.change) >= 0 ? '+' : ''}{coin.change}%
                </div>
              </button>
            ))}
          </div>

          {/* Full board */}
          <div className="panel p-3 lg:flex-1 lg:min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-2 shrink-0 mb-2">
              <div className="panel-ti">
                Market Board <span className="text-cyan-neon/50">({sorted.length})</span>
              </div>
              <div className="flex gap-1">
                {CATEGORY_TABS.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    className={cn(
                      'text-[11px] font-black uppercase tracking-widest px-2 py-1 rounded-sm border transition-all',
                      activeCategory === cat
                        ? 'border-cyan-neon bg-cyan-neon/10 text-cyan-neon'
                        : 'border-white/5 text-white/40 hover:text-white/50 hover:border-white/20'
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div className="lg:flex-1 lg:min-h-0 overflow-x-auto overflow-y-auto custom-scrollbar">
              <table className="w-full text-[12px] font-mono">
                <thead className="sticky top-0 bg-navy/95 backdrop-blur-sm z-10">
                  <tr className="text-white/45 uppercase text-[10px] tracking-widest">
                    <th className="text-left font-black py-1.5 pr-2">Symbol</th>
                    <th className="text-right font-black py-1.5 pr-2">Price</th>
                    {SORT_COLUMNS.map(col => (
                      <th key={col.key} className="text-right py-1.5 pr-2">
                        <button
                          onClick={() => onSort(col.key)}
                          className={cn(
                            'font-black uppercase tracking-widest transition-colors',
                            sortKey === col.key ? 'text-cyan-neon' : 'text-white/45 hover:text-white/50'
                          )}
                        >
                          {col.label}{sortKey === col.key ? (sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
                        </button>
                      </th>
                    ))}
                    <th className="text-right font-black py-1.5">Vol</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(coin => (
                    <tr
                      key={coin.symbol}
                      onClick={() => handleSelectSymbol(coin.symbol)}
                      className={cn(
                        'border-t border-white/5 cursor-pointer transition-colors',
                        selectedSymbol === coin.symbol ? 'bg-cyan-neon/[0.06]' : 'hover:bg-white/[0.03]'
                      )}
                    >
                      <td className="py-1.5 pr-2 text-white font-black">
                        {coin.symbol.split('-')[0]}
                        {selectedSymbol === coin.symbol && <span className="ml-1.5 text-cyan-neon text-[10px]">●</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-white/70">{coin.price}</td>
                      <td className="py-1.5 pr-2 text-right text-cyan-neon/70">{Number(coin.scalpScore).toFixed(0)}</td>
                      <td className={cn(
                        'py-1.5 pr-2 text-right font-bold',
                        parseFloat(coin.change) >= 0 ? 'text-green-400' : 'text-red-400'
                      )}>
                        {parseFloat(coin.change) >= 0 ? '+' : ''}{coin.change}%
                      </td>
                      <td className={cn(
                        'py-1.5 pr-2 text-right font-bold',
                        coin.rsi < 35 ? 'text-green-400' : coin.rsi > 65 ? 'text-red-400' : 'text-white/60'
                      )}>
                        {coin.rsi?.toFixed(0)}
                      </td>
                      <td className="py-1.5 text-right">
                        <span className={cn(
                          'px-1 rounded-[2px] text-[10px] font-black tracking-tighter',
                          coin.volumeTrend === 'HIGH' ? 'bg-cyan-neon/15 text-cyan-neon'
                            : coin.volumeTrend === 'LOW' ? 'bg-red-500/15 text-red-400'
                              : 'bg-white/5 text-white/40'
                        )}>
                          {coin.volumeTrend || '—'} {coin.volumeRatio ? `${coin.volumeRatio}×` : ''}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Intel rail ───────────────────────────────────────────────────── */}
        <section className="lg:col-span-4 flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto custom-scrollbar">
          {/* Strict Sharia screen — every universe asset passes strict-v1 */}
          <div className="panel p-3 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="panel-ti flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-green-400/70" />
                Strict Sharia Screen
              </div>
              <button
                onClick={() => setScreenOpen(v => !v)}
                className="text-[11px] font-black uppercase tracking-widest text-cyan-neon/60 hover:text-cyan-neon transition-colors"
              >
                {screenOpen ? 'Hide' : `Excluded (${EXCLUDED_BASES.length})`}
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono">
              <span className="text-green-400/80 font-black">{SYMBOLS.length} assets</span>
              <span className="text-white/40">·</span>
              <span className="text-white/50">{SCREEN_VERSION}</span>
              <span className="text-white/40">·</span>
              <span className="text-green-400/60 font-black">100% COMPLIANT</span>
            </div>
            {screenOpen && (
              <div className="mt-2 pt-2 border-t border-white/5 space-y-1">
                {SHARIA_CRITERIA.map(c => (
                  <div key={c.id} className="flex items-center gap-1.5 text-[11px] text-white/55">
                    <ShieldCheck className="w-2.5 h-2.5 text-green-400/50 shrink-0" />
                    {c.label}
                  </div>
                ))}
                <div className="pt-1.5 mt-1.5 border-t border-white/5 space-y-1">
                  {Object.entries(EXCLUDED).map(([sym, reason]) => (
                    <div key={sym} className="flex items-baseline justify-between gap-2 text-[11px] font-mono">
                      <span className="text-red-400/70 font-black shrink-0">{sym.split('-')[0]}</span>
                      <span className="text-white/45 text-right">{reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Fundamentals */}
          <div className="panel p-3 shrink-0">
            <div className="panel-ti mb-2 flex items-center gap-2">
              <Activity className="w-3 h-3" />
              Fundamentals {fundamentals?.rank ? <span className="text-cyan-neon/50">· #{fundamentals.rank}</span> : null}
              {fundamentals ? (
                <span className="ml-auto text-[10px] font-black px-1.5 py-0.5 rounded-[2px] bg-green-500/15 text-green-400 tracking-wider">
                  {screenStatus(selectedSymbol).verdict}
                </span>
              ) : null}
            </div>
            {fundamentals ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">Mkt Cap</div>
                    <div className="text-[13px] font-black text-white font-mono">{fmtUsd(fundamentals.marketCap)}</div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">7D</div>
                    <div className={cn('text-[13px] font-black font-mono', Number(fundamentals.change7d) >= 0 ? 'text-green-400' : 'text-red-400')}>
                      {Number(fundamentals.change7d)?.toFixed(1) ?? '—'}%
                    </div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">30D</div>
                    <div className={cn('text-[13px] font-black font-mono', Number(fundamentals.change30d) >= 0 ? 'text-green-400' : 'text-red-400')}>
                      {Number(fundamentals.change30d)?.toFixed(1) ?? '—'}%
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[11px] font-mono text-white/50">
                  <span>ATH {fmtUsd(fundamentals.ath)}</span>
                  <span className={cn(Number(fundamentals.athChange) >= 0 ? 'text-green-400/70' : 'text-red-400/70')}>
                    {Number(fundamentals.athChange)?.toFixed(1) ?? '—'}% from ATH
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] font-mono text-white/50">
                  <span>Supply {fmtNum(fundamentals.circulating)}</span>
                  <span>Max {fmtNum(fundamentals.maxSupply)}</span>
                </div>
                {fundamentals.description && (
                  <p className="text-[12px] text-white/55 leading-snug line-clamp-3">{fundamentals.description}</p>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-white/40 italic py-1">Syncing CoinGecko fundamentals…</div>
            )}
          </div>

          {/* Fear & Greed + source health */}
          <div className="panel p-3 shrink-0 space-y-2">
            <div className="flex items-center justify-between">
              <span className="panel-ti">Fear & Greed</span>
              {fearGreed ? (
                <span className={cn(
                  'text-[13px] font-black font-mono px-2 py-0.5 rounded-sm',
                  parseInt(fearGreed.value) < 25 ? 'bg-green-500/15 text-green-400'
                    : parseInt(fearGreed.value) > 75 ? 'bg-red-500/15 text-red-400'
                      : 'bg-yellow-500/15 text-yellow-400'
                )}>
                  {fearGreed.value} — {fearGreed.label}
                </span>
              ) : (
                <span className="text-[12px] text-white/40 italic">syncing…</span>
              )}
            </div>
            <div className="pt-2 border-t border-white/5 space-y-1">
              <div className="text-[11px] font-black uppercase tracking-widest text-white/40 flex items-center gap-1.5">
                <Database className="w-2.5 h-2.5" /> Source Health
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[10px] text-white/45 uppercase">Price</div>
                  <div className={cn('text-[12px] font-black font-mono', status === 'LIVE' ? 'text-green-400' : 'text-yellow-400')}>
                    {priceSource}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/45 uppercase">Candles</div>
                  <div className={cn('text-[12px] font-black font-mono', candleSource === 'BINANCE' ? 'text-green-400' : 'text-cyan-neon/70')}>
                    {candleSource}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/45 uppercase">Funds</div>
                  <div className={cn('text-[12px] font-black font-mono', fundamentals ? 'text-green-400' : 'text-yellow-400')}>
                    {fundamentals ? 'COINGECKO ✓' : 'SYNCING'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Global pulse + retail heat — keyless CoinGecko macro layer */}
          <div className="panel p-3 shrink-0 space-y-2">
            <div className="panel-ti">Global Pulse</div>
            {globalStats ? (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="tile p-2">
                  <div className="text-[10px] text-white/50 uppercase mb-1">Total Mcap</div>
                  <div className="text-[12px] font-black text-white font-mono">{fmtUsd(globalStats.totalMcap)}</div>
                </div>
                <div className="tile p-2">
                  <div className="text-[10px] text-white/50 uppercase mb-1">24H</div>
                  <div className={cn('text-[12px] font-black font-mono', Number(globalStats.mcapChange24h) >= 0 ? 'text-green-400' : 'text-red-400')}>
                    {Number.isFinite(Number(globalStats.mcapChange24h)) ? `${Number(globalStats.mcapChange24h) >= 0 ? '+' : ''}${Number(globalStats.mcapChange24h).toFixed(2)}%` : '—'}
                  </div>
                </div>
                <div className="tile p-2">
                  <div className="text-[10px] text-white/50 uppercase mb-1">BTC.D</div>
                  <div className="text-[12px] font-black text-white font-mono">
                    {Number.isFinite(Number(globalStats.btcDominance)) ? `${Number(globalStats.btcDominance).toFixed(1)}%` : '—'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-white/40 italic py-1">Syncing macro layer…</div>
            )}
            <div className="pt-2 border-t border-white/5">
              <div className="text-[11px] font-black uppercase tracking-widest text-white/40 flex items-center gap-1.5 mb-1.5">
                <Flame className="w-2.5 h-2.5 text-orange-400/70" /> Retail Heat
              </div>
              {trending.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {trending.map(t => (
                    <span key={t.id || t.symbol} className="px-1.5 py-0.5 rounded-[2px] text-[11px] font-black font-mono bg-cyan-neon/10 text-cyan-neon/70 border border-cyan-neon/15">
                      {t.symbol}{Number.isFinite(Number(t.change24h)) ? ` ${Number(t.change24h) >= 0 ? '+' : ''}${Number(t.change24h).toFixed(1)}%` : ''}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-white/40 italic">Scanning search flows…</div>
              )}
            </div>
          </div>

          {/* Engine stats — header toggle */}
          {showDevMode && diagnostics && (
            <div className="panel p-3 shrink-0">
              <div className="panel-ti mb-2 flex items-center gap-2">
                <Cpu className="w-3 h-3 text-cyan-neon" />
                Engine Stats
              </div>
              <div className="font-mono text-[12px] text-white/60 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] text-white/40 uppercase font-black tracking-widest">Scans</span>
                  <span>{diagnostics.scans}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[11px] text-white/40 uppercase font-black tracking-widest">Errors</span>
                  <span className={diagnostics.errors > 0 ? 'text-red-400' : ''}>{diagnostics.errors}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[11px] text-white/40 uppercase font-black tracking-widest">Last Asset</span>
                  <span>{diagnostics.lastAsset}</span>
                </div>
                <div className="pt-1.5 border-t border-white/5">
                  <span className="text-[11px] text-white/40 uppercase font-black tracking-widest">Last Calc</span>
                  <div className="mt-1 text-cyan-neon/70 break-all leading-relaxed">{diagnostics.lastCalc}</div>
                </div>
              </div>
            </div>
          )}

          {/* Alpha news wire */}
          <div className="panel p-3 lg:flex-1 lg:min-h-0 flex flex-col shrink-0">
            <div className="flex items-center justify-between shrink-0 mb-2">
              <div className="flex items-center gap-2">
                <Newspaper className="w-3.5 h-3.5 text-cyan-neon" />
                <span className="panel-ti">Alpha News</span>
              </div>
              <div className="flex gap-1">
                <div className="w-1 h-1 rounded-full bg-cyan-neon animate-pulse" />
                <div className="w-1 h-1 rounded-full bg-cyan-neon/20" />
              </div>
            </div>
            <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto custom-scrollbar space-y-3">
              {news && news.length > 0 ? news.map(item => {
                const title = item.title.toLowerCase();
                const isBullish = /launch|partnership|listing|buyback|burn|upgrade|growth|surge|bullish|win|approved|detected/.test(title);
                const isBearish = /hack|exploit|scam|dump|bearish|delist|regulatory|sec|lawsuit|security/.test(title);

                const timeAgo = nowSec ? Math.floor((nowSec - item.time) / 60) : 0;
                const timeDisplay = timeAgo < 1 ? 'Just now' : timeAgo < 60 ? `${timeAgo}m ago` : `${Math.floor(timeAgo / 60)}h ago`;

                return (
                  <div key={item.id} className="group cursor-default border-b border-white/5 pb-3 last:border-0">
                    <div className="flex justify-between items-start gap-3 mb-1.5">
                      <div className={cn(
                        'px-1.5 py-0.5 rounded-[2px] text-[10px] font-black uppercase tracking-tighter shrink-0',
                        isBullish ? 'bg-green-500/20 text-green-400'
                          : isBearish ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-white/50'
                      )}>
                        {isBullish ? 'Catalyst' : isBearish ? 'Threat' : 'Intel'}
                      </div>
                      <span className="text-[11px] font-mono text-white/35 uppercase font-bold">{timeDisplay}</span>
                    </div>
                    <div className="text-[13px] text-white/70 leading-snug group-hover:text-white transition-colors font-medium">
                      {item.title}
                    </div>
                    <div className="text-[12px] text-cyan-neon/40 font-bold uppercase tracking-widest mt-1.5">{item.source}</div>
                  </div>
                );
              }) : (
                <div className="h-full flex flex-col items-center justify-center text-[12px] text-white/40 gap-3 py-6">
                  <div className="w-8 h-8 rounded-full border-2 border-cyan-neon/10 border-t-cyan-neon animate-spin" />
                  <span className="italic uppercase tracking-widest">Establishing Uplink...</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
