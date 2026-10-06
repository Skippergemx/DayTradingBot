import { useMemo, useState } from 'react';
import { cn } from '../lib/utils';
import { fmtPrice } from '../lib/ict';
import { BINANCE_SKIP } from '../lib/universe';
import { ChartPanel } from './ChartPanel';

const FINAL_TRADE_STATUSES = new Set(['WIN', 'LOSS', 'ABANDONED', 'EXPIRED']);
const CATEGORY_TABS = ['ALL', 'CORE', 'GAMING', 'AI'];
const TIMEFRAMES = ['1m', '15m', '1h'];

export const ChartTab = ({
  filteredCoins,
  selectedSymbol,
  selectedData,
  handleSelectSymbol,
  activeCategory,
  setActiveCategory,
  candles,
  dayBook,
  day1hBook,
  trades,
  selectedStructure,
  isDayBreakout,
  isDayCapitulation,
}) => {
  const [timeframe, setTimeframe] = useState('1m');

  const base = selectedSymbol.split('-')[0];
  const noPair = BINANCE_SKIP.includes(base);

  // Source planes per timeframe: 1m = the live 200-bar scan book for the
  // selected symbol; 15m/1h = the day planes (warmed on boot for the selected
  // symbol, rotating into the rest of the board).
  const bars = useMemo(() => {
    if (timeframe === '1m') return Array.isArray(candles) ? candles : [];
    if (timeframe === '15m') return dayBook?.[selectedSymbol] || [];
    return day1hBook?.[selectedSymbol] || [];
  }, [timeframe, candles, dayBook, day1hBook, selectedSymbol]);

  const activeTrades = useMemo(
    () => trades.filter(t => t.symbol === selectedSymbol && (t.status === 'OPEN' || t.status === 'PENDING')),
    [trades, selectedSymbol]
  );
  const historyTrades = useMemo(
    () => trades.filter(t => t.symbol === selectedSymbol && FINAL_TRADE_STATUSES.has(t.status)),
    [trades, selectedSymbol]
  );

  // Active setup card: live position wins, else the engine's armed preview.
  const liveTrade = activeTrades[0] || null;
  const setup = selectedStructure?.setup || null;
  const livePnl = liveTrade && liveTrade.status === 'OPEN' && selectedData?.price
    ? ((parseFloat(selectedData.price) - liveTrade.entry) / liveTrade.entry) * 100
    : null;

  const cardRows = liveTrade
    ? [
        { label: 'Entry', value: fmtPrice(liveTrade.entry) },
        { label: 'Stop', value: fmtPrice(liveTrade.stopLoss), tone: 'text-red-400' },
        { label: 'Target', value: Number.isFinite(liveTrade.target) ? fmtPrice(liveTrade.target) : '∞', tone: 'text-green-400' },
        { label: 'Size', value: `$${Number(liveTrade.size || 0).toFixed(0)}` },
        { label: 'PnL', value: livePnl === null ? '—' : `${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}%`, tone: livePnl === null ? '' : livePnl >= 0 ? 'text-green-400' : 'text-red-400' },
      ]
    : setup
      ? [
          { label: 'Entry', value: fmtPrice(setup.entry) },
          { label: 'Stop', value: fmtPrice(setup.stop), tone: 'text-red-400' },
          { label: 'Target', value: Number.isFinite(setup.target) ? fmtPrice(setup.target) : '∞', tone: 'text-green-400' },
          { label: 'R:R', value: setup.rr ? `${setup.rr}R` : '—' },
        ]
      : [];

  return (
    <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 overflow-y-auto custom-scrollbar">
      {/* Watchlist rail — category tabs + the categorized board */}
      <aside className="md:w-[280px] md:shrink-0 flex flex-col gap-2 md:min-h-0">
        <div className="flex gap-1 shrink-0">
          {CATEGORY_TABS.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                'flex-1 text-[11px] font-black uppercase tracking-widest py-1.5 rounded-sm border transition-all',
                activeCategory === cat
                  ? 'border-cyan-neon bg-cyan-neon/10 text-cyan-neon'
                  : 'border-white/5 text-white/40 hover:text-white/50 hover:border-white/20'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="flex md:flex-col gap-1.5 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto custom-scrollbar pb-1 md:pb-0 md:flex-1 md:min-h-0">
          {filteredCoins.map((coin) => (
            <button
              key={coin.symbol}
              onClick={() => handleSelectSymbol(coin.symbol)}
              className={cn(
                'min-w-[118px] md:min-w-0 md:w-full px-2.5 py-2 rounded-sm border text-left transition-all flex items-center justify-between gap-2 shrink-0',
                selectedSymbol === coin.symbol
                  ? 'border-cyan-neon/60 bg-cyan-neon/[0.06]'
                  : 'border-white/5 bg-white/[0.02] hover:border-cyan-neon/25'
              )}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-white leading-tight truncate">{coin.symbol.split('-')[0]}</div>
                <div className="text-[12px] font-mono text-slate-400 leading-tight truncate">{coin.price}</div>
              </div>
              <div className="text-right shrink-0">
                <div className={cn(
                  'text-[12px] font-mono font-bold',
                  parseFloat(coin.change) >= 0 ? 'text-green-400' : 'text-red-400'
                )}>
                  {coin.change}%
                </div>
                <div className="text-[11px] font-mono text-slate-400">RSI {coin.rsi?.toFixed(0)}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Chart column */}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
        {/* Symbol header + timeframe switch */}
        <div className="flex items-center justify-between gap-2 shrink-0 flex-wrap">
          <div className="flex items-baseline gap-3 min-w-0">
            <span className="text-lg font-bold text-white leading-none">{base}</span>
            <span className="text-sm font-mono text-slate-300 leading-none">${selectedData?.price ?? '—'}</span>
            <span className={cn(
              'text-[13px] font-mono font-bold leading-none',
              parseFloat(selectedData?.change) >= 0 ? 'text-green-400' : 'text-red-400'
            )}>
              {selectedData?.change}%
            </span>
            <span className="text-[12px] font-mono text-slate-400 leading-none">
              RSI {selectedData?.rsi?.toFixed(0) ?? '—'} · {bars.length} × {timeframe}
            </span>
          </div>
          <div className="flex gap-1">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={cn(
                  'text-[12px] font-black uppercase tracking-widest px-3 py-1 rounded-sm border transition-all',
                  timeframe === tf
                    ? 'border-cyan-neon bg-cyan-neon/10 text-cyan-neon'
                    : 'border-white/5 text-white/45 hover:text-white/50 hover:border-white/20'
                )}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* The chart */}
        <div className="relative flex-1 min-h-[300px] rounded-sm border border-white/5 bg-slate-950/40 overflow-hidden">
          {noPair ? (
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center space-y-1">
                <div className="text-[13px] uppercase tracking-[0.3em] text-slate-400">No chart for {base}</div>
                <div className="text-[12px] font-mono text-slate-400">No Binance spot pair — candles unavailable on this market.</div>
              </div>
            </div>
          ) : (
            <ChartPanel
              bars={bars}
              datasetKey={`${selectedSymbol}|${timeframe}`}
              activeTrades={activeTrades}
              historyTrades={historyTrades}
            />
          )}
        </div>

        {/* Active setup card + engine telemetry strip */}
        <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_340px] shrink-0">
          {selectedStructure && (
            <div className={cn(
              'panel px-2.5 py-1.5 space-y-1',
              isDayBreakout ? 'border-rose-400/15 bg-rose-400/[0.03]'
                : isDayCapitulation ? 'border-sky-400/15 bg-sky-400/[0.03]'
                  : 'border-purple-400/15 bg-purple-400/[0.03]'
            )}>
              <div className="flex items-center justify-between">
                <span className={cn(
                  'text-[11px] font-black uppercase tracking-widest',
                  isDayBreakout ? 'text-rose-300/60'
                    : isDayCapitulation ? 'text-sky-300/60'
                      : 'text-purple-300/60'
                )}>
                  {isDayBreakout ? 'Day NR7 Engine' : isDayCapitulation ? 'Day RSI2 Engine' : 'ICT Engine'}
                </span>
                <span className="text-[10px] font-mono text-white/45">
                  {isDayBreakout
                    ? (selectedStructure.compression
                        ? `NR7 ${selectedStructure.compression.rangePct}% range · ${selectedStructure.compression.volRatio}× vol`
                        : 'hunting compression')
                    : isDayCapitulation
                      ? (selectedStructure.oversold
                          ? `RSI2 ${selectedStructure.oversold.rsi2 ?? '—'} · ${selectedStructure.oversold.volRatio}× vol`
                          : 'hunting the flush')
                      : selectedStructure.killzone?.active
                        ? `${selectedStructure.killzone.label} · ${selectedStructure.killzone.minutesLeft}m left`
                        : selectedStructure.killzone?.next
                          ? `next: ${selectedStructure.killzone.next.label} in ${selectedStructure.killzone.next.startsInMin}m`
                          : 'killzone —'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={cn(
                  'text-[10px] font-black tracking-wider px-1 py-0.5 rounded-sm border',
                  selectedStructure.state === 'EXECUTING' || selectedStructure.state === 'DAY_EXECUTING' ? 'text-green-400 border-green-400/30 bg-green-400/5'
                    : selectedStructure.state === 'FVG_MITIGATION' || selectedStructure.state === 'DAY_COMPRESSION' ? 'text-amber-300 border-amber-300/30 bg-amber-300/5'
                      : selectedStructure.state === 'DISPLACEMENT_DETECTED' ? 'text-cyan-neon border-cyan-neon/30 bg-cyan-neon/5'
                        : selectedStructure.state === 'WAITING_FOR_KILLZONE' ? 'text-purple-300 border-purple-300/30 bg-purple-300/5'
                          : 'text-white/40 border-white/10 bg-white/[0.02]'
                )}>
                  [{selectedStructure.state}]
                </span>
                <span className={cn(
                  'text-[10px] font-mono',
                  selectedStructure.bias === 'BULLISH' ? 'text-green-400/80' : selectedStructure.bias === 'BEARISH' ? 'text-red-400/80' : 'text-white/45'
                )}>
                  {selectedStructure.bias === 'BULLISH' ? '▲' : selectedStructure.bias === 'BEARISH' ? '▼' : '◆'} {selectedStructure.bias}
                </span>
                {selectedStructure.fvg && (
                  <span className="text-[10px] font-mono text-white/55">
                    FVG {fmtPrice(selectedStructure.fvg.bottom)}–{fmtPrice(selectedStructure.fvg.top)} · CE {fmtPrice(selectedStructure.fvg.ce)}
                  </span>
                )}
                {selectedStructure.zone && (
                  <span className="text-[10px] font-mono text-white/55">
                    {selectedStructure.zone.kind === 'NR7_BREAK' ? 'NR7 break' : 'Zone'} {fmtPrice(selectedStructure.zone.bottom)}–{fmtPrice(selectedStructure.zone.top)} · entry {fmtPrice(selectedStructure.zone.entry)}
                  </span>
                )}
                {selectedStructure.compression && (
                  <span className="text-[10px] font-mono text-white/55">
                    NR7 {fmtPrice(selectedStructure.compression.low)}–{fmtPrice(selectedStructure.compression.high)} · {selectedStructure.compression.rangePct}% · {selectedStructure.compression.volRatio}× vol
                  </span>
                )}
                {selectedStructure.oversold && (
                  <span className="text-[10px] font-mono text-white/55">
                    RSI2 {selectedStructure.oversold.rsi2 ?? '—'} · {selectedStructure.oversold.volRatio}× vol
                  </span>
                )}
              </div>
              <div className="text-[11px] font-mono leading-snug text-white/55">
                {selectedStructure.missing
                  ? `Missing: ${selectedStructure.missing}`
                  : `Armed: entry ${fmtPrice(selectedStructure.setup?.entry)} · stop ${fmtPrice(selectedStructure.setup?.stop)} · target ${Number.isFinite(selectedStructure.setup?.target) ? fmtPrice(selectedStructure.setup?.target) : '∞'} (${selectedStructure.setup?.rr}R)`}
              </div>
            </div>
          )}

          <div className={cn('panel px-2.5 py-1.5 space-y-1.5', !selectedStructure && 'xl:col-span-2')}>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black uppercase tracking-widest text-cyan-neon/60">Active Setup</span>
              {liveTrade ? (
                <span className={cn(
                  'text-[10px] font-black uppercase tracking-widest px-1 py-0.5 rounded-sm border',
                  liveTrade.status === 'OPEN'
                    ? 'text-green-400 border-green-400/30 bg-green-400/5'
                    : 'text-amber-300 border-amber-300/30 bg-amber-300/5'
                )}>
                  {liveTrade.status} · {liveTrade.strategy?.replace(/_/g, ' ') || 'desk'}
                </span>
              ) : (
                <span className="text-[10px] font-black uppercase tracking-widest text-white/40">engine preview</span>
              )}
            </div>
            {cardRows.length ? (
              <div className="flex items-center gap-3 flex-wrap">
                {cardRows.map(row => (
                  <div key={row.label} className="min-w-[54px]">
                    <div className="text-[10px] font-black uppercase tracking-widest text-white/45">{row.label}</div>
                    <div className={cn('text-[12px] font-mono font-bold text-white/80', row.tone)}>{row.value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] font-mono text-white/45 italic">No active setup on {base} — the engine is still hunting.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
