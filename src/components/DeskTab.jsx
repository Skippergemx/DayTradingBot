import { useMemo } from 'react';
import {
  Activity, MessageCircle, Zap, Timer, BarChart3, ShieldAlert, Target,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { fmtPrice } from '../lib/ict';
import { ChatModule } from './ChatModule';

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const FINAL_TRADE_STATUSES = new Set(['WIN', 'LOSS', 'ABANDONED', 'EXPIRED']);
const CURRENT_DESKS = new Set(['ICT_PRECISION', 'DAY_BREAKOUT', 'DAY_CAPITULATION']);

const DESK_LABELS = {
  ICT_PRECISION: 'ICT Sniper',
  DAY_BREAKOUT: 'Day Breakout',
  DAY_CAPITULATION: 'Day Cap',
};

const REPORT_ROWS = [
  { id: 'ICT_PRECISION', label: 'ICT Sniper', tone: 'text-purple-300' },
  { id: 'DAY_BREAKOUT', label: 'Day Breakout', tone: 'text-rose-300' },
  { id: 'DAY_CAPITULATION', label: 'Day Cap', tone: 'text-sky-300' },
  { id: 'LEGACY', label: 'Legacy (pre-meta)', tone: 'text-slate-400' },
];

// Per-desk profitability lens: settled trades bucketed by the strategy field,
// anything not on a current desk (or pre-meta nulls) rolls into LEGACY.
const bucketOf = (t) => (CURRENT_DESKS.has(t.strategy) ? t.strategy : 'LEGACY');

export const DeskTab = ({
  advice,
  adviceMeta,
  isAnalyzing,
  selectedData,
  trades,
  stats,
  balance,
  availableBalance,
  setSelectedTrade,
  handleResetAudit,
  autopilotOn,
  toggleAutopilot,
  autopilotNotice,
  vio8Thoughts,
  selectedSymbol,
  marketData,
  hourlyTrend,
  kingdomThreat,
  breaker,
  scoreboard,
}) => {
  const ai = advice || {
    tech: [],
    fund: [],
    risk: 'LOW',
    verdict: 'WAIT',
    feeling: 'Re-establishing tactical link...',
    entry: 0,
    stopLoss: 0,
    target: 0,
    rationale: 'Standing by for intel sync.',
  };

  const verdictStyles = ai.verdict === 'EXECUTE LONG'
    ? { border: 'border-signal-pink', text: 'text-signal-pink', bg: 'bg-signal-pink/10', glow: 'shadow-[0_0_30px_rgba(255,0,193,0.15)]' }
    : ai.verdict === 'MONITOR'
      ? { border: 'border-yellow-400/50', text: 'text-yellow-400', bg: 'bg-yellow-400/5', glow: '' }
      : { border: 'border-white/10', text: 'text-white/40', bg: 'bg-white/5', glow: '' };

  const priceMap = useMemo(() => {
    const map = {};
    for (const m of marketData) {
      const p = parseFloat(m.price);
      if (Number.isFinite(p) && p > 0) map[m.symbol] = p;
    }
    return map;
  }, [marketData]);

  const openTrades = useMemo(
    () => trades.filter(t => t.status === 'OPEN' || t.status === 'PENDING'),
    [trades]
  );

  const reportCard = useMemo(() => {
    const rows = Object.fromEntries(REPORT_ROWS.map(r => [r.id, { n: 0, wins: 0, losses: 0, net: 0, open: 0 }]));
    for (const t of trades) {
      const row = rows[bucketOf(t)];
      if (FINAL_TRADE_STATUSES.has(t.status)) {
        row.n += 1;
        if (t.status === 'WIN') row.wins += 1;
        if (t.status === 'LOSS') row.losses += 1;
        row.net += Number(t.usdPnl) || 0;
      } else if (t.status === 'OPEN' || t.status === 'PENDING') {
        row.open += 1;
      }
    }
    return rows;
  }, [trades]);

  const livePnlOf = (t) => {
    if (t.status !== 'OPEN') return null;
    const price = priceMap[t.symbol];
    if (!price || !t.entry) return null;
    return ((price - t.entry) / t.entry) * 100;
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden custom-scrollbar">
      <div className="grid gap-3 lg:grid-cols-12 lg:h-full">
        {/* ── Main desk column ─────────────────────────────────────────────── */}
        <section className="lg:col-span-8 flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto custom-scrollbar">
          {/* Verdict hero */}
          <div className={cn(
            'panel px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 shrink-0',
            ai.verdict === 'EXECUTE LONG' ? 'border-signal-pink/40 bg-signal-pink/[0.04]' : ai.verdict === 'MONITOR' ? 'border-yellow-400/25 bg-yellow-400/[0.03]' : 'border-white/10 bg-white/[0.02]'
          )}>
            <div className="flex items-center gap-4 min-w-0">
              <div className={cn(
                'px-5 py-2 rounded-full border-2 text-lg font-black tracking-tighter uppercase flex items-center gap-2 shrink-0 transition-all duration-700',
                verdictStyles.border, verdictStyles.text, verdictStyles.glow
              )}>
                {ai.verdict === 'EXECUTE LONG' ? <Zap className="w-5 h-5 animate-pulse" /> : <Timer className="w-5 h-5 opacity-40" />}
                {ai.verdict}
              </div>
              <p className="text-[14px] text-white/70 font-medium italic leading-snug min-w-0 truncate">
                "{ai.rationale}"
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isAnalyzing && (
                <span className="text-[11px] text-cyan-neon/50 animate-pulse tracking-widest uppercase font-mono">Analyzing…</span>
              )}
              <div className={cn(
                'text-[12px] font-black uppercase px-3 py-1 rounded-sm border tracking-widest',
                ai.risk === 'HIGH' ? 'border-red-500/40 text-red-400 bg-red-500/5'
                  : ai.risk === 'MEDIUM' ? 'border-yellow-400/40 text-yellow-400 bg-yellow-500/5'
                    : 'border-green-400/40 text-green-400 bg-green-500/5'
              )}>
                Risk: {ai.risk}
              </div>
            </div>
          </div>

          {/* Vio8 briefing + readouts */}
          <div className="panel p-4 shrink-0 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-black text-cyan-neon uppercase tracking-[0.2em] flex items-center gap-2">
                <MessageCircle className="w-3.5 h-3.5" />
                Vio8 Briefing
              </div>
              {isAnalyzing && <span className="text-[11px] text-cyan-neon/50 animate-pulse tracking-widest uppercase font-mono">Syncing signal…</span>}
            </div>
            <p className="text-[14px] text-white/90 leading-relaxed font-medium italic border-l-2 border-cyan-neon/60 pl-3">
              "{isAnalyzing ? 'Processing multi-layer data matrices...' : ai.feeling}"
            </p>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Technical pulse */}
              <div className="space-y-3">
                <div className="text-[12px] font-black text-white/40 uppercase tracking-[0.2em] flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-cyan-neon" />
                  Technical Pulse
                </div>
                <div className="space-y-2">
                  {ai.tech.map((t, i) => (
                    <div key={i} className="flex gap-3 items-start group">
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-neon/30 mt-1.5 shrink-0 group-hover:bg-cyan-neon transition-colors" />
                      <span className="text-[13px] text-white/50 leading-snug group-hover:text-white/90 transition-colors">{t}</span>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="tile p-2.5 text-center">
                    <div className="text-[10px] text-white/40 uppercase font-black mb-1 tracking-widest">RSI</div>
                    <div className={cn('text-lg font-black font-mono leading-none', selectedData?.rsi < 35 ? 'text-green-400' : selectedData?.rsi > 65 ? 'text-red-400' : 'text-white')}>
                      {selectedData?.rsi?.toFixed(1) ?? '—'}
                    </div>
                  </div>
                  <div className="tile p-2.5 text-center">
                    <div className="text-[10px] text-white/40 uppercase font-black mb-1 tracking-widest">Mean Dist</div>
                    <div className={cn('text-lg font-black font-mono leading-none', selectedData?.emaDist > 0.5 ? 'text-cyan-neon' : selectedData?.emaDist < -0.5 ? 'text-orange-400' : 'text-white')}>
                      {selectedData?.emaDist?.toFixed(2) ?? '—'}%
                    </div>
                  </div>
                </div>
              </div>

              {/* Market gravity */}
              <div className="space-y-3">
                <div className="text-[12px] font-black text-white/40 uppercase tracking-[0.2em] flex items-center gap-2">
                  <BarChart3 className="w-3.5 h-3.5 text-cyan-neon" />
                  Market Gravity
                </div>
                <div className="space-y-2">
                  {ai.fund.map((f, i) => (
                    <div key={i} className="flex gap-3 items-start group">
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-neon/30 mt-1.5 shrink-0 group-hover:bg-cyan-neon transition-colors" />
                      <span className="text-[13px] text-white/50 leading-snug group-hover:text-white/90 transition-colors">{f}</span>
                    </div>
                  ))}
                </div>
                <div className="tile p-2.5">
                  <div className="text-[10px] text-white/40 uppercase font-black mb-2 tracking-widest">Volume Pressure</div>
                  <div className="h-1.5 w-full bg-white/5 rounded-full mb-2 overflow-hidden">
                    <div
                      className={cn('h-full transition-all duration-1000', selectedData?.volumePressure > 60 ? 'bg-cyan-neon' : selectedData?.volumePressure < 40 ? 'bg-red-500' : 'bg-white/20')}
                      style={{ width: `${selectedData?.volumePressure || 50}%` }}
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className={cn('text-sm font-black font-mono', selectedData?.volumePressure > 60 ? 'text-cyan-neon' : 'text-white/40')}>{selectedData?.volumePressure ?? 50}%</span>
                    <span className="text-[11px] font-black text-white/40 uppercase">{selectedData?.volumePressure > 60 ? 'Buying pressure' : 'Consolidating'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Target identification */}
            <div className="pt-3 border-t border-white/5">
              <div className="text-[12px] font-black text-white/40 uppercase mb-3 tracking-[0.2em]">Target Identification</div>
              {(!ai.entry || ai.entry === 0) ? (
                <div className="p-4 bg-white/[0.02] border border-white/10 rounded-sm text-center flex items-center justify-center gap-3">
                  <ShieldAlert className="w-4 h-4 text-white/35" />
                  <span className="text-[12px] font-black text-white/40 uppercase tracking-[0.2em]">Wait mode — no active targets identified</span>
                </div>
              ) : (
                <div className="flex gap-3 flex-col sm:flex-row">
                  <div className="flex-1 p-3 bg-cyan-500/5 border border-cyan-500/10 rounded-sm hover:border-cyan-500/30 transition-colors">
                    <div className="text-[11px] font-black text-cyan-400 uppercase tracking-widest mb-1">Entry</div>
                    <div className="text-sm font-black text-white font-mono leading-none">${ai.entry}</div>
                    <div className="text-[11px] text-white/50 uppercase mt-1.5 font-bold tracking-tighter line-clamp-1">{ai.entryDesc || 'Limit entry'}</div>
                  </div>
                  <div className="flex-1 p-3 bg-red-500/5 border border-red-500/10 rounded-sm hover:border-red-500/30 transition-colors">
                    <div className="text-[11px] font-black text-red-400 uppercase tracking-widest mb-1">Stop Loss</div>
                    <div className="text-sm font-black text-white font-mono leading-none">${ai.stopLoss}</div>
                    <div className="text-[11px] text-white/50 uppercase mt-1.5 font-bold tracking-tighter line-clamp-1">{ai.stopDesc || 'Structural support'}</div>
                  </div>
                  <div className="flex-1 p-3 bg-green-500/5 border border-green-500/10 rounded-sm hover:border-green-500/30 transition-colors">
                    <div className="text-[11px] font-black text-green-400 uppercase tracking-widest mb-1">Profit Target</div>
                    <div className="text-sm font-black text-white font-mono leading-none">${ai.target}</div>
                    <div className="text-[11px] text-white/50 uppercase mt-1.5 font-bold tracking-tighter line-clamp-1">{ai.targetDesc || 'Local resistance'}</div>
                  </div>
                </div>
              )}
            </div>

            {/* 1H range alignment */}
            {hourlyTrend && (
              <div className="pt-3 border-t border-white/5">
                <div className="text-[12px] font-black text-white/40 uppercase mb-3 tracking-[0.2em]">1H Range Alignment</div>
                <div className="relative h-2 bg-white/5 rounded-full overflow-hidden mb-2">
                  <div className="absolute h-full bg-gradient-to-r from-green-500/20 via-cyan-neon/20 to-red-500/20 w-full" />
                  <div
                    className="absolute top-0 w-1 h-full bg-white shadow-[0_0_10px_white] transition-all duration-1000"
                    style={{ left: `${Math.max(0, Math.min(100, ((selectedData?.price - hourlyTrend.swingLow) / (hourlyTrend.swingHigh - hourlyTrend.swingLow)) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] font-black text-white/35 tracking-widest">
                  <div className="flex flex-col">
                    <span>SUPPORT</span>
                    <span className="text-white/50 font-mono">${hourlyTrend.swingLow}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span>RESISTANCE</span>
                    <span className="text-white/50 font-mono">${hourlyTrend.swingHigh}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Risk officer ruling */}
          {advice?.verdict === 'EXECUTE LONG' && adviceMeta?.gate && (
            adviceMeta.gate.ok ? (
              <div className="panel px-4 py-2 bg-green-400/5 border-green-400/30 shrink-0">
                <div className="text-[12px] font-bold text-green-400/90 uppercase tracking-wider">
                  Risk Officer: Cleared — paper trade armed
                </div>
              </div>
            ) : (
              <div className="panel px-4 py-2 bg-red-400/5 border-red-400/40 shrink-0">
                <div className="text-[12px] font-bold text-red-400/90 uppercase tracking-wider">Risk Officer: Held</div>
                <div className="text-[12px] text-red-300/70 font-mono mt-0.5">{adviceMeta.gate.reasons.join(' · ')}</div>
              </div>
            )
          )}

          {/* Positions table */}
          <div className="panel p-3 shrink-0">
            <div className="panel-ti mb-2">
              Positions <span className="text-cyan-neon/50">({openTrades.length})</span>
            </div>
            {openTrades.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] font-mono">
                  <thead>
                    <tr className="text-white/45 uppercase text-[10px] tracking-widest">
                      <th className="text-left font-black py-1 pr-2">Symbol</th>
                      <th className="text-left font-black py-1 pr-2">Desk</th>
                      <th className="text-left font-black py-1 pr-2">Status</th>
                      <th className="text-right font-black py-1 pr-2">Entry</th>
                      <th className="text-right font-black py-1 pr-2">Stop</th>
                      <th className="text-right font-black py-1 pr-2">Target</th>
                      <th className="text-right font-black py-1 pr-2">Size</th>
                      <th className="text-right font-black py-1">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openTrades.map(t => {
                      const pnl = livePnlOf(t);
                      return (
                        <tr
                          key={t.id}
                          onClick={() => setSelectedTrade(t)}
                          className="border-t border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                        >
                          <td className="py-1.5 pr-2 text-white font-black">{t.symbol.split('-')[0]}</td>
                          <td className="py-1.5 pr-2 text-white/40">{DESK_LABELS[t.strategy] || t.strategy?.replace(/_/g, ' ') || '—'}</td>
                          <td className="py-1.5 pr-2">
                            <span className={cn(
                              'px-1 rounded-[2px] text-[10px] font-black tracking-tighter',
                              t.status === 'OPEN' ? 'bg-green-500/20 text-green-400' : 'bg-cyan-500/20 text-cyan-400'
                            )}>
                              {t.status}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 text-right text-white/70">{fmtPrice(t.entry)}</td>
                          <td className="py-1.5 pr-2 text-right text-red-400/80">{fmtPrice(t.stopLoss)}</td>
                          <td className="py-1.5 pr-2 text-right text-green-400/80">{Number.isFinite(Number(t.target)) ? fmtPrice(t.target) : '∞'}</td>
                          <td className="py-1.5 pr-2 text-right text-white/50">${Number(t.size || 0).toFixed(0)}</td>
                          <td className={cn('py-1.5 text-right font-bold', pnl === null ? 'text-white/45' : pnl >= 0 ? 'text-green-400' : 'text-red-400')}>
                            {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[12px] text-white/40 italic py-2">Flat — no open positions on any desk.</div>
            )}
          </div>

          {/* Desk report card — the per-strategy profitability lens */}
          <div className="panel p-3 shrink-0">
            <div className="panel-ti mb-2 flex items-center gap-2">
              <BarChart3 className="w-3 h-3" />
              Desk Report Card
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] font-mono">
                <thead>
                  <tr className="text-white/45 uppercase text-[10px] tracking-widest">
                    <th className="text-left font-black py-1 pr-2">Desk</th>
                    <th className="text-right font-black py-1 pr-2">Settled</th>
                    <th className="text-right font-black py-1 pr-2">W–L</th>
                    <th className="text-right font-black py-1 pr-2">Win%</th>
                    <th className="text-right font-black py-1 pr-2">Net $</th>
                    <th className="text-right font-black py-1">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {REPORT_ROWS.map(r => {
                    const row = reportCard[r.id];
                    const decisive = row.wins + row.losses;
                    return (
                      <tr key={r.id} className="border-t border-white/5">
                        <td className={cn('py-1.5 pr-2 font-black', r.tone)}>{r.label}</td>
                        <td className="py-1.5 pr-2 text-right text-white/60">{row.n}</td>
                        <td className="py-1.5 pr-2 text-right text-white/60">
                          <span className="text-green-400">{row.wins}</span>
                          <span className="text-white/45">–</span>
                          <span className="text-red-400">{row.losses}</span>
                        </td>
                        <td className="py-1.5 pr-2 text-right text-white/60">{decisive ? `${Math.round((row.wins / decisive) * 100)}%` : '—'}</td>
                        <td className={cn('py-1.5 pr-2 text-right font-bold', row.net > 0 ? 'text-green-400' : row.net < 0 ? 'text-red-400' : 'text-white/40')}>
                          {row.net >= 0 ? '+' : ''}{row.net.toFixed(2)}
                        </td>
                        <td className="py-1.5 text-right text-cyan-neon/60">{row.open || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Scoreboard — trailing 7d, vs BTC buy-and-hold */}
          <div className="panel p-3 shrink-0">
            <div className="panel-ti mb-2 flex items-center gap-2">
              <Target className="w-3 h-3" />
              Scoreboard — trailing 7d
              <span className="text-white/40 normal-case font-mono font-bold">
                {scoreboard ? `· since ${scoreboard.windowDays.toFixed(1)}d` : ''}
              </span>
            </div>
            {scoreboard ? (
              <>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-center mb-2">
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">Net</div>
                    <div className={cn('text-[13px] font-black font-mono', scoreboard.net > 0 ? 'text-green-400' : scoreboard.net < 0 ? 'text-red-400' : 'text-white/60')}>
                      {scoreboard.net >= 0 ? '+' : ''}${scoreboard.net.toFixed(2)}
                    </div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">Trades</div>
                    <div className="text-[13px] font-black font-mono text-white/70">{scoreboard.n}</div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">Win%</div>
                    <div className="text-[13px] font-black font-mono text-white/70">{scoreboard.wrPct ?? '—'}</div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">PF</div>
                    <div className="text-[13px] font-black font-mono text-white/70">{scoreboard.pf === null ? '—' : scoreboard.pf === Infinity ? '∞' : scoreboard.pf.toFixed(2)}</div>
                  </div>
                  <div className="tile p-2">
                    <div className="text-[10px] text-white/50 uppercase mb-1">Max DD</div>
                    <div className="text-[13px] font-black font-mono text-red-400/80">−${scoreboard.maxDD.toFixed(2)}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[12px] font-mono mb-2">
                  <span className="text-white/50">vs BTC buy-hold</span>
                  {scoreboard.ready ? (
                    <span className={cn('font-black', scoreboard.vsBtcUsd >= 0 ? 'text-green-400' : 'text-red-400')}>
                      {scoreboard.vsBtcUsd >= 0 ? '+' : ''}${scoreboard.vsBtcUsd.toFixed(2)} ({scoreboard.btcDeltaPct >= 0 ? '+' : ''}{scoreboard.btcDeltaPct.toFixed(2)}% BTC)
                    </span>
                  ) : (
                    <span className="text-white/40 italic">benchmark syncing…</span>
                  )}
                </div>
                {scoreboard.desks.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px] font-mono">
                      <thead>
                        <tr className="text-white/45 uppercase text-[10px] tracking-widest">
                          <th className="text-left font-black py-1 pr-2">Desk</th>
                          <th className="text-right font-black py-1 pr-2">Settled</th>
                          <th className="text-right font-black py-1 pr-2">Win%</th>
                          <th className="text-right font-black py-1 pr-2">PF</th>
                          <th className="text-right font-black py-1 pr-2">Net $</th>
                          <th className="text-right font-black py-1">Max DD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scoreboard.desks.map(d => (
                          <tr key={d.tag} className="border-t border-white/5">
                            <td className="py-1.5 pr-2 font-black text-white/70">{d.tag}</td>
                            <td className="py-1.5 pr-2 text-right text-white/60">{d.n}</td>
                            <td className="py-1.5 pr-2 text-right text-white/60">{d.wrPct ?? '—'}</td>
                            <td className="py-1.5 pr-2 text-right text-white/60">{d.pf === null ? '—' : d.pf === Infinity ? '∞' : d.pf.toFixed(2)}</td>
                            <td className={cn('py-1.5 pr-2 text-right font-bold', d.net > 0 ? 'text-green-400' : d.net < 0 ? 'text-red-400' : 'text-white/40')}>
                              {d.net >= 0 ? '+' : ''}{d.net.toFixed(2)}
                            </td>
                            <td className="py-1.5 text-right text-red-400/70">−{d.maxDD.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-[12px] text-white/40 italic">No settled trades in the window yet.</div>
                )}
              </>
            ) : (
              <div className="text-[12px] text-white/40 italic py-1">Scoreboard syncing — waiting for the first price marks…</div>
            )}
          </div>

          {/* Recent operations */}
          <div className="panel p-3 shrink-0">
            <div className="panel-ti mb-2">Recent Operations</div>
            <div className="space-y-2">
              {trades.slice(0, 10).map(t => (
                <div
                  key={t.id}
                  onClick={() => setSelectedTrade(t)}
                  className="p-2 rounded-sm bg-black/40 border border-white/5 space-y-1.5 cursor-pointer hover:border-cyan-neon/40 hover:bg-white/[0.02] transition-all group"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-[12px] font-black text-white tracking-wide group-hover:text-cyan-neon transition-colors">{t.symbol.split('-')[0]}</span>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-[12px] font-black font-mono',
                        parseFloat(t.pnl) >= 0 ? 'text-green-400' : 'text-red-400'
                      )}>
                        {t.pnl}%
                      </span>
                      <span className={cn(
                        'px-1 rounded-[2px] text-[11px] font-black tracking-tighter',
                        t.status === 'WIN' ? 'bg-green-500/20 text-green-400'
                          : t.status === 'LOSS' ? 'bg-red-500/20 text-red-400'
                            : t.status === 'PENDING' ? 'bg-cyan-500/20 text-cyan-400'
                              : t.status === 'ABANDONED' ? 'bg-amber-500/20 text-amber-400'
                                : t.status === 'EXPIRED' ? 'bg-white/5 text-white/40' : 'bg-white/10 text-white/40'
                      )}>
                        {t.status}
                      </span>
                      {t.legacy && (
                        <span className="px-1 rounded-[2px] text-[11px] font-black tracking-tighter bg-white/10 text-white/60">
                          LEGACY
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[11px] font-mono text-white/50">
                    <div>
                      <div className="uppercase">Entry</div>
                      <div className="text-white/60">${t.entry}</div>
                    </div>
                    <div className="text-center">
                      <div className="uppercase">Target</div>
                      <div className="text-white/60">${t.target ?? '∞'}</div>
                    </div>
                    <div className="text-right">
                      <div className="uppercase">Price</div>
                      <div className="text-white/60">${t.currentPrice || t.exitPrice || t.entry}</div>
                    </div>
                  </div>
                </div>
              ))}
              {trades.length === 0 && (
                <div className="text-[12px] text-white/35 italic text-center py-2">Waiting for first signal...</div>
              )}
            </div>
          </div>
        </section>

        {/* ── Right rail: wallet, autopilot, thoughts, chat ────────────────── */}
        <section className="lg:col-span-4 flex flex-col gap-3 lg:min-h-0">
          {/* Paper wallet */}
          <div className="panel p-4 shrink-0">
            <div className="flex justify-between items-start mb-3">
              <div className="flex-1">
                <div className="panel-ti mb-1 flex items-center justify-between pr-4">
                  Paper Wallet
                  {stats.streak > 0 && (
                    <span className={cn(
                      'px-2 py-0.5 rounded-full text-[11px] font-black border animate-pulse',
                      stats.streak >= 3 ? 'bg-orange-500/20 border-orange-500/40 text-orange-400' : 'bg-green-500/10 border-green-500/20 text-green-400'
                    )}>
                      {stats.streak} WIN STREAK
                    </span>
                  )}
                </div>
                <div className={cn(
                  'text-xl font-black font-mono leading-none transition-all duration-700',
                  stats.streak >= 3 ? 'text-orange-400 drop-shadow-[0_0_10px_rgba(251,146,60,0.3)]' : 'text-white'
                )}>
                  ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[11px] text-white/50 font-bold mt-1 uppercase tracking-tighter flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Activity className="w-2.5 h-2.5" />
                    Max Win Streak: {stats.maxStreak}
                  </div>
                  <div className="italic">Available: ${availableBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  <div className={cn('flex items-center gap-1.5', breaker?.tripped ? 'text-red-400' : 'text-white/45')}>
                    {breaker?.tripped ? (
                      <span className="px-1.5 py-0.5 rounded-[2px] bg-red-500/20 border border-red-500/40 font-black animate-pulse tracking-wider">BREAKER</span>
                    ) : (
                      <>
                        <ShieldAlert className="w-2.5 h-2.5" />
                        Daily breaker armed
                      </>
                    )}
                    <span className="opacity-70 font-mono normal-case">
                      {breaker ? `${breaker.realizedNet >= 0 ? '+' : ''}${breaker.realizedNet.toFixed(2)} / −${breaker.limitUsd.toFixed(0)}` : 'syncing'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleResetAudit}
                  className="mt-2 text-[10px] text-white/35 hover:text-red-500/50 transition-colors uppercase font-bold tracking-tighter"
                >
                  Reset portfolio audit
                </button>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[12px] font-black font-mono text-cyan-neon bg-cyan-neon/10 px-2 py-0.5 rounded-sm mb-1">
                  WIN RATE: {stats.winRate}%
                </div>
                <div className={cn(
                  'text-[12px] font-bold font-mono',
                  balance >= 10000 ? 'text-green-400' : 'text-red-400'
                )}>
                  {balance >= 10000 ? '+' : ''}{(balance - 10000).toFixed(2)} USDT
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="tile p-2 text-center">
                <div className="text-[11px] text-white/50 uppercase mb-1">Wins</div>
                <div className="text-sm font-black text-green-400 font-mono">{stats.wins}</div>
              </div>
              <div className="tile p-2 text-center">
                <div className="text-[11px] text-white/50 uppercase mb-1">Losses</div>
                <div className="text-sm font-black text-red-400 font-mono">{stats.losses}</div>
              </div>
            </div>
          </div>

          {/* Autopilot */}
          <div className="shrink-0 space-y-1">
            <button
              onClick={toggleAutopilot}
              className={cn(
                'w-full text-[12px] font-black uppercase tracking-widest py-2 rounded-sm border transition-all',
                autopilotOn
                  ? 'border-cyan-neon bg-cyan-neon/10 text-cyan-neon'
                  : 'border-white/5 text-white/45 hover:text-white/50 hover:border-white/20'
              )}
            >
              {autopilotOn ? 'Vio8 Autopilot: Hunting' : 'Vio8 Autopilot: Off'}
            </button>
            {autopilotOn && autopilotNotice && (
              <div className={cn(
                'px-2 py-1 border-l-2 rounded-r-sm',
                autopilotNotice.manual ? 'bg-white/5 border-white/20' : 'bg-cyan-neon/5 border-cyan-neon/30'
              )}>
                <div className={cn(
                  'text-[11px] font-mono leading-tight',
                  autopilotNotice.manual ? 'text-white/40' : 'text-cyan-neon/80'
                )}>
                  {autopilotNotice.manual ? 'HOLD' : 'FOCUS'} → {autopilotNotice.symbol.split('-')[0]} — {autopilotNotice.reasons.join(' · ')}
                </div>
              </div>
            )}
          </div>

          {/* Vio8 thought stream */}
          <div className="glass-panel border-white/10 bg-white/[0.02] rounded-sm overflow-hidden shrink-0">
            <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-white/5">
              <span className="text-[11px] font-black uppercase tracking-widest text-cyan-neon/60">Vio8 Thoughts</span>
              <span className={cn(
                'text-[10px] font-black uppercase tracking-widest',
                isAnalyzing ? 'text-cyan-neon animate-pulse' : 'text-white/40'
              )}>
                {isAnalyzing ? `reading ${selectedSymbol.split('-')[0]}…` : 'live'}
              </span>
            </div>
            <div className="h-48 overflow-y-auto custom-scrollbar px-2 py-1.5 space-y-1">
              {vio8Thoughts.map(th => {
                const tone = th.kind === 'ict' ? 'text-purple-300/85'
                  : th.kind === 'day' ? 'text-rose-300/85'
                    : th.kind === 'mover' ? 'text-amber-300/80'
                      : th.kind === 'scan' ? 'text-cyan-neon/70'
                        : th.kind === 'rule' ? 'text-red-300/80'
                          : th.kind === 'trade'
                            ? th.tone === 'win' ? 'text-green-400'
                              : th.tone === 'loss' ? 'text-red-400'
                                : th.tone === 'warn' ? 'text-amber-400/80'
                                  : th.tone === 'muted' ? 'text-white/45'
                                    : 'text-cyan-200/80'
                            : 'text-slate-300/85';
                const tag = th.kind === 'ict' ? 'ICT' : th.kind === 'day' ? 'DAY' : th.kind === 'mover' ? 'MOVER' : th.kind === 'scan' ? 'SCAN' : th.kind === 'rule' ? 'RULE' : th.kind === 'trade' ? 'TRADE' : 'READ';
                return (
                  <div key={th.id} className="flex gap-1.5 items-start">
                    <span className="text-[10px] font-mono text-white/40 shrink-0 mt-[1px] w-10">{hhmmss(th.t)}</span>
                    <div className={cn('text-[11px] font-mono leading-snug min-w-0', tone)}>
                      <span className="opacity-40 font-black mr-1">[{tag}]</span>
                      {th.verdict && <span className="opacity-60 mr-1">{th.verdict}</span>}
                      {th.text}
                    </div>
                  </div>
                );
              })}
              {vio8Thoughts.length === 0 && (
                <div className="text-[11px] text-white/40 italic text-center py-4">She has not spoken yet — her thoughts will stream here as she scans.</div>
              )}
            </div>
          </div>

          {/* Chat desk */}
          <div className="shrink-0 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
            <ChatModule
              selectedSymbol={selectedSymbol}
              marketData={marketData}
              hourlyTrend={hourlyTrend}
              trades={trades}
              kingdomThreat={kingdomThreat}
            />
          </div>
        </section>
      </div>
    </div>
  );
};
