import { Cpu, Database, Activity, Target, ShieldAlert, Layers, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils';

// The command deck keeps the engine's threat enum untouched — display only.
const REGIME_LABELS = { PEACE: 'CALM', UNREST: 'CHOPPY', WAR: 'RISK-OFF', CATASTROPHE: 'VOLATILE' };

const DESK_LABELS = {
  ICT_PRECISION: 'ICT Sniper',
  DAY_BREAKOUT: 'Day Breakout',
  DAY_CAPITULATION: 'Day Cap',
};

const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(Number(n) || 0).toFixed(2)}`;

// Command-row feed chip — one source, one health lamp.
const FeedChip = ({ label, value, ok }) => (
  <div className="flex items-center gap-1.5">
    <Database className="w-3 h-3 text-cyan-neon/50" />
    <span className="text-cyan-neon/55">{label}</span>
    <span className={cn('font-mono', ok ? 'text-green-400' : 'text-yellow-400')}>{value}</span>
  </div>
);

// One KPI tile in the rail — label / value / sub, tone via a utility override.
const Kpi = ({ icon: Icon, label, value, sub, tone }) => (
  <div className="kpi">
    <div className="kpi-l flex items-center gap-1.5">
      {Icon ? <Icon className="w-2.5 h-2.5 opacity-50" /> : null}
      {label}
    </div>
    <div className={cn('kpi-v', tone)}>{value}</div>
    <div className="kpi-s">{sub}</div>
  </div>
);

/**
 * CommandBar — the professional top chrome: a command row (brand, feed health,
 * engine-stats toggle) over a live KPI rail scored off the paper book and the
 * capital guards. Purely presentational; every value is passed in.
 */
export const CommandBar = ({
  balance, availableBalance, trades, stats, breaker, scoreboard,
  kingdomThreat, strategy, isDay, btcTrendGate,
  autopilotOn, selectedSymbol,
  status, priceSource, candleSource, fundamentals, fearGreed, isAnalyzing,
  showDevMode, setShowDevMode,
}) => {
  const openTrades = trades.filter(t => t.status === 'OPEN' || t.status === 'PENDING');
  const openRisk = openTrades.reduce((acc, t) => acc + (Number(t.risk) || 0), 0);
  const dayPnl = breaker?.realizedNet ?? 0;
  const dayLimit = breaker?.limitUsd ?? 0;
  const equityDelta = balance - 10000;
  const regime = REGIME_LABELS[kingdomThreat] || kingdomThreat || '—';
  const deskLabel = DESK_LABELS[strategy] || strategy || '—';
  const focus = selectedSymbol ? selectedSymbol.split('-')[0] : '—';
  const vsBtc = scoreboard?.ready ? scoreboard.vsBtcUsd : null;
  const feedLive = status === 'LIVE';

  return (
    <div className="shrink-0 z-50 border-b border-white/5 bg-navy/70 backdrop-blur-md">
      {/* ── Command row ────────────────────────────────────────────────────── */}
      <div className="h-14 flex items-center px-3 md:px-5 justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-sm bg-cyan-neon/10 border border-cyan-neon/25 flex items-center justify-center shrink-0">
            <Cpu className={cn('w-4 h-4 text-cyan-neon', isAnalyzing && 'animate-spin')} />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-base font-bold tracking-tight text-white font-outfit leading-none">
                Vortex<span className="text-cyan-neon/80">.Zen</span>
              </h1>
              <span className="hidden sm:inline text-[10px] font-mono font-bold text-white/30 uppercase tracking-[0.28em]">Command Deck</span>
            </div>
            <p className="text-[10px] text-cyan-neon/50 tracking-[0.28em] uppercase font-medium mt-0.5">Day-Trading Terminal</p>
          </div>
        </div>

        <div className="flex items-center gap-3 md:gap-5 min-w-0">
          <div className="hidden xl:flex items-center gap-4 text-[11px] font-bold tracking-[0.14em] uppercase">
            <FeedChip label="Price" value={priceSource} ok={feedLive} />
            <FeedChip label="Candles" value={candleSource} ok={candleSource === 'BINANCE'} />
            <FeedChip label="Fund" value={fundamentals ? 'CG ✓' : 'SYNC'} ok={!!fundamentals} />
            {fearGreed && (
              <div className="flex items-center gap-1.5 border-l border-white/10 pl-4">
                <span className="text-white/45">F&amp;G</span>
                <span className={cn(
                  'font-mono font-black',
                  parseInt(fearGreed.value) < 25 ? 'text-green-400'
                    : parseInt(fearGreed.value) > 75 ? 'text-red-400' : 'text-yellow-400'
                )}>
                  {fearGreed.value}
                </span>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowDevMode(!showDevMode)}
            className="hidden min-[420px]:inline-block text-[11px] font-bold text-white/40 uppercase tracking-widest hover:text-cyan-neon/60 transition-colors"
          >
            {showDevMode ? 'Hide Stats' : 'Engine Stats'}
          </button>
        </div>
      </div>

      {/* ── KPI rail ───────────────────────────────────────────────────────── */}
      <div className="border-t border-white/5">
        <div className="flex overflow-x-auto no-scrollbar">
          <Kpi
            icon={Activity}
            label="Equity"
            value={usd(balance)}
            tone={equityDelta >= 0 ? 'text-green-400' : 'text-red-400'}
            sub={<>{money(equityDelta)} vs $10k · avail {usd(availableBalance)}</>}
          />
          <Kpi
            icon={Target}
            label="Day P&L"
            value={money(dayPnl)}
            tone={dayPnl > 0 ? 'text-green-400' : dayPnl < 0 ? 'text-red-400' : 'text-white/70'}
            sub={<>limit −{dayLimit.toFixed(0)} · {breaker?.tripped ? <span className="text-red-400 font-bold">BREAKER</span> : 'armed'}</>}
          />
          <Kpi
            icon={ShieldAlert}
            label="Open Risk"
            value={usd(openRisk)}
            tone={openRisk > 0 ? 'text-amber-300' : 'text-white/60'}
            sub={<>{openTrades.length} position{openTrades.length === 1 ? '' : 's'} live</>}
          />
          <Kpi
            icon={Layers}
            label="Win Rate"
            value={stats.total ? `${stats.winRate}%` : '—'}
            tone="text-cyan-neon"
            sub={<>{stats.wins}W · {stats.losses}L · streak {stats.streak}</>}
          />
          <Kpi
            icon={BarChart3}
            label="7D Edge"
            value={vsBtc != null ? money(vsBtc) : '—'}
            tone={vsBtc != null ? (vsBtc >= 0 ? 'text-green-400' : 'text-red-400') : 'text-white/50'}
            sub={scoreboard ? <>net {money(scoreboard.net)} · {scoreboard.n} settled</> : 'syncing'}
          />
          <Kpi
            label="Regime"
            value={regime}
            tone={regime === 'CALM' ? 'text-green-400' : regime === 'CHOPPY' ? 'text-yellow-400' : 'text-red-400'}
            sub={isDay ? (btcTrendGate ? 'BTC trend gates armed' : 'BTC trend gates OFF') : 'ICT 1H sniper'}
          />
          <Kpi
            label="Desk"
            value={deskLabel}
            tone="text-white"
            sub={autopilotOn ? `Vio8 hunting · ${focus}` : `focus ${focus} · Vio8 off`}
          />
        </div>
      </div>
    </div>
  );
};
