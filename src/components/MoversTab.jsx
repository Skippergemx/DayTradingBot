import { useMemo } from 'react';
import { Radar } from 'lucide-react';
import { cn } from '../lib/utils';
import { MOVERS, VERDICT_TEXT, GATE_TEXT } from '../lib/journal';

const DESK_LABELS = { ICT_PRECISION: 'ICT', DAY_BREAKOUT: 'NR7', DAY_CAPITULATION: 'RSI2' };
const DESK_LONG = { ICT_PRECISION: 'ICT Precision', DAY_BREAKOUT: 'Day Breakout', DAY_CAPITULATION: 'Day Cap' };

const VERDICT_TONE = {
  TAKEN: 'bg-green-500/15 text-green-400 border-green-500/25',
  HELD_GATE: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  HELD_CAP: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  HELD_BREAKER: 'bg-red-500/15 text-red-400 border-red-500/25',
  HELD_FEE: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  HELD_COOLDOWN: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  HELD_CORRELATED: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  UNFOCUSED: 'bg-purple-500/15 text-purple-300 border-purple-500/25',
  READY: 'bg-cyan-neon/10 text-cyan-neon border-cyan-neon/25',
  REFUSED: 'bg-white/5 text-white/40 border-white/10',
  NO_DATA: 'bg-white/5 text-white/45 border-white/5',
};

const DETAIL_TONE = {
  TAKEN: 'text-green-400/70',
  UNFOCUSED: 'text-purple-300/60',
  READY: 'text-cyan-neon/70',
  REFUSED: 'text-white/40',
  NO_DATA: 'text-white/45',
};

// The day desks' desk-wide regime gates, in checklist order. The breakout desk
// doesn't read the rising-SMA10 gate, so it is hidden while that desk is active.
const REGIME_CHIPS = [
  { id: 'btcUp', label: 'BTC 1h', read: (r) => r.btcUp },
  { id: 'btcD10', label: 'BTC daily', read: (r) => r.btcD10 },
  { id: 'btcD10r', label: 'SMA10 ↗', read: (r) => r.btcD10r },
];

// Why a downed desk-wide gate matters — the same voice as the desk narratives.
const REGIME_WHY = {
  btcUp: 'BTC is not in a 1h uptrend — the day desk only longs with the king; every refusal below parks at this one shared gate.',
  btcD10: 'BTC closed under its daily SMA10 — day-longs lack the daily wind.',
  btcD10r: 'BTC SMA10 is not rising — capitulation bids wait for a healing daily.',
};

// Round-12: with the switch off, both trend reads (1h uptrend + SMA10-rising)
// are bypassed — the banner says so instead of blaming gates the desk no longer
// walks.
const BYPASS_WHY = 'BTC trend gates bypassed (switch off) — the 1h uptrend and SMA10-rising reads are off; only the daily position wall (close > SMA10) stands.';

// Day-desk refusals carry the engine's full gate checklist (daydesk.js gateScan).
// When the first unmet gate is desk-wide (BTC regime), the ledger shows that one
// reason once in the banner and gives the row its own asset-side story instead.
const GATE_ENRICH = (m) => {
  const gates = Array.isArray(m.gates) ? m.gates : null;
  if (!gates || !gates.length) return null;
  const firstFail = gates.find(g => !g.ok);
  if (!firstFail) return null;
  const asset = gates.filter(g => !GATE_TEXT[g.id]?.wide);
  const fails = asset.filter(g => !g.ok);
  const next = fails[0] || null;
  return {
    wide: GATE_TEXT[firstFail.id]?.wide === true,
    firstLabel: GATE_TEXT[firstFail.id]?.label || firstFail.id,
    cleared: fails.length === 0,
    green: asset.filter(g => g.ok).length,
    total: asset.length,
    next: next ? { label: GATE_TEXT[next.id]?.label || next.id, note: next.note } : null,
    tip: gates.map(g => `${GATE_TEXT[g.id]?.label || g.id} ${g.ok ? '✓' : '✗'}${g.note ? ` (${g.note})` : ''}`).join('\n'),
  };
};

const groupOf = (v) => (
  v === 'TAKEN' ? 'taken'
    : typeof v === 'string' && v.startsWith('HELD_') ? 'held'
      : v === 'UNFOCUSED' || v === 'READY' ? 'ready'
        : 'refused'
);

const signed = (v) => `${v >= 0 ? '+' : ''}${Number(v ?? 0).toFixed(2)}%`;

const StatChip = ({ label, n, cls }) => (
  <div className={cn('px-2 py-1 rounded-sm border text-center min-w-[64px]', cls)}>
    <div className="text-[10px] font-black uppercase tracking-widest opacity-70">{label}</div>
    <div className="text-[14px] font-black font-mono leading-none mt-0.5">{n}</div>
  </div>
);

export const MoversTab = ({ movers, selectedSymbol, handleSelectSymbol, desk, now, regime = null }) => {
  const rows = useMemo(() => [...movers].sort((a, b) => {
    const magA = Math.max(a.peak ?? 0, -(a.trough ?? 0));
    const magB = Math.max(b.peak ?? 0, -(b.trough ?? 0));
    return magB - magA || (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
  }), [movers]);

  const counts = useMemo(() => {
    const c = { taken: 0, held: 0, ready: 0, refused: 0 };
    for (const r of movers) c[groupOf(r.verdict)] += 1;
    return c;
  }, [movers]);

  const regimeChips = regime ? REGIME_CHIPS.filter(c => !(desk === 'DAY_BREAKOUT' && c.id === 'btcD10r')) : [];
  const btcTrendBypass = Boolean(regime?.btcTrendBypass);
  const bypassable = (id) => id === 'btcUp' || id === 'btcD10r'; // the two trend reads the switch drops
  const regimeFail = regime ? regimeChips.find(c => !c.read(regime) && !(bypassable(c.id) && btcTrendBypass)) : null;

  const today = Number.isFinite(now) ? new Date(now).toISOString().slice(0, 10) : '';
  const fmtStamp = (t) => {
    if (!t) return '—';
    const d = new Date(t).toISOString();
    return (d.slice(0, 10) === today ? '' : `${d.slice(5, 10)} `) + d.slice(11, 16);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3" data-movers-panel data-rows={rows.length}>
      {/* ── Header: what the ledger is + the day's tally ──────────────────── */}
      <header className="panel p-3 shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Radar className="w-3.5 h-3.5 text-cyan-neon" />
            <span className="text-[12px] font-black uppercase tracking-widest text-white/70">Mover Radar</span>
            <span className="text-[11px] text-white/45 uppercase tracking-widest">missed-opportunity ledger</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatChip label="Taken" n={counts.taken} cls="border-green-500/25 bg-green-500/10 text-green-400" />
            <StatChip label="Held" n={counts.held} cls="border-amber-500/25 bg-amber-500/10 text-amber-400" />
            <StatChip label="Ready · Missed" n={counts.ready} cls="border-purple-500/25 bg-purple-500/10 text-purple-300" />
            <StatChip label="Refused" n={counts.refused} cls="border-white/10 bg-white/5 text-white/45" />
          </div>
        </div>
        <p className="mt-2 text-[11px] font-mono text-white/50 leading-relaxed">
          Flags every asset whose rolling 24h move crosses ±{MOVERS.MIN_MOVE_PCT}% · verdicts read against the{' '}
          <span className="text-cyan-neon/60">{DESK_LONG[desk] || desk}</span> desk and only ever upgrade
          (taken &gt; held &gt; unfocused &gt; refused) · observed peaks are never lost, flags expire after 7 days.
        </p>
        {regime && regimeChips.length > 0 && (
          <div
            className="mt-2 pt-2 border-t border-white/5 flex items-center gap-x-2 gap-y-1 flex-wrap"
            data-desk-regime={regimeFail ? 'down' : 'open'}
          >
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">Desk regime</span>
            {regimeChips.map(c => {
              const ok = Boolean(c.read(regime));
              const bypassed = bypassable(c.id) && btcTrendBypass;
              return (
                <span
                  key={c.id}
                  className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border text-[10px] font-mono',
                    bypassed ? 'border-amber-500/25 bg-amber-500/10 text-amber-400'
                      : ok ? 'border-green-500/25 bg-green-500/10 text-green-400'
                        : 'border-red-500/25 bg-red-500/10 text-red-400'
                  )}
                >
                  {c.label} {bypassed ? '∅' : ok ? '✓' : '✗'}
                </span>
              );
            })}
            <span className={cn('text-[11px] font-mono leading-relaxed', regimeFail ? 'text-white/50' : 'text-cyan-neon/70')}>
              {regimeFail ? REGIME_WHY[regimeFail.id]
                : btcTrendBypass ? BYPASS_WHY
                  : 'regime open — refusals below are asset-specific.'}
            </span>
          </div>
        )}
      </header>

      {/* ── Ledger ────────────────────────────────────────────────────────── */}
      <div className="panel p-2 flex-1 min-h-0 flex flex-col">
        {rows.length > 0 && (
          <div className="grid grid-cols-[110px_1fr_104px] md:grid-cols-[110px_110px_1fr_104px] gap-2 items-center px-1.5 pb-1.5 border-b border-white/5 shrink-0 text-[10px] font-black uppercase tracking-widest text-white/40">
            <span>Asset</span>
            <span className="hidden md:block">Move · Peak</span>
            <span>Verdict · Exact Reason</span>
            <span className="text-right">Desk · Seen</span>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {rows.map(m => {
            const held = typeof m.verdict === 'string' && m.verdict.startsWith('HELD_');
            const gi = m.verdict === 'REFUSED' ? GATE_ENRICH(m) : null;
            return (
              <button
                key={m.id}
                onClick={() => handleSelectSymbol(m.symbol)}
                className={cn(
                  'w-full grid grid-cols-[110px_1fr_104px] md:grid-cols-[110px_110px_1fr_104px] gap-2 items-center px-1.5 py-2 border-b border-white/5 last:border-0 text-left transition-colors',
                  selectedSymbol === m.symbol ? 'bg-cyan-neon/[0.06]' : 'hover:bg-white/[0.03]'
                )}
              >
                {/* Asset */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-[13px] font-black font-mono text-white truncate">{m.symbol.split('-')[0]}</span>
                    {selectedSymbol === m.symbol && <span className="text-cyan-neon text-[10px] shrink-0">●</span>}
                  </div>
                  <div className="text-[11px] font-mono text-white/50 truncate">${m.price ?? '—'}</div>
                </div>

                {/* Move · peak */}
                <div className="hidden md:block min-w-0">
                  <div className={cn('text-[13px] font-black font-mono', (m.change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400')}>
                    {(m.change ?? 0) >= 0 ? '▲ ' : '▼ '}{signed(m.change)}
                  </div>
                  <div className="text-[11px] font-mono text-white/50 truncate">
                    pk {signed(m.peak)} · lo {signed(m.trough)}
                  </div>
                </div>

                {/* Verdict + exact reason */}
                <div className="min-w-0">
                  <span className={cn(
                    'inline-block px-1.5 py-0.5 rounded-[2px] text-[10px] font-black tracking-tighter border',
                    VERDICT_TONE[m.verdict] || VERDICT_TONE.NO_DATA
                  )}>
                    {VERDICT_TEXT[m.verdict] || m.verdict || 'FLAGGED'}{m.tradeStatus ? ` · ${m.tradeStatus}` : ''}
                  </span>
                  <div
                    className={cn(
                      'text-[11px] font-mono leading-snug mt-0.5 truncate',
                      held ? 'text-amber-300/60' : (DETAIL_TONE[m.verdict] || 'text-white/55')
                    )}
                    title={m.detail || ''}
                  >
                    {gi && gi.wide ? `desk-wide regime — ${gi.firstLabel} ✗` : (m.detail || '—')}
                  </div>
                  {gi && (
                    <div
                      className={cn('text-[11px] font-mono leading-snug mt-0.5 truncate', gi.cleared ? 'text-cyan-neon/70' : 'text-white/45')}
                      title={gi.tip}
                    >
                      {gi.wide
                        ? gi.cleared
                          ? `asset gates ${gi.total}/${gi.total} ✓ — only the desk regime blocks this one`
                          : `asset gates ${gi.green}/${gi.total} green · next wall: ${gi.next.label}${gi.next.note ? ` (now ${gi.next.note})` : ''}`
                        : `asset gates ${gi.green}/${gi.total} green`}
                    </div>
                  )}
                </div>

                {/* Desk · seen */}
                <div className="text-right min-w-0">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/45">{DESK_LABELS[m.desk] || '—'}</div>
                  <div className="text-[11px] font-mono text-white/50">{fmtStamp(m.lastSeen)}</div>
                </div>
              </button>
            );
          })}

          {rows.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-2 py-10">
              <Radar className="w-6 h-6 text-cyan-neon/20" />
              <div className="text-[12px] text-white/50 italic">No ≥{MOVERS.MIN_MOVE_PCT}% movers flagged yet.</div>
              <div className="text-[11px] font-mono text-white/40 max-w-[380px] text-center leading-relaxed">
                Every big move lands here with the desk's exact verdict — taken, held by a guard,
                ready-but-unfocused, or refused and why. Click a row to put the desk on it.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
