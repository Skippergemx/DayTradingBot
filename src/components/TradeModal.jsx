import { X, ShieldAlert, TrendingUp, Clock, CircleDollarSign, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils';

export const TradeModal = ({ trade, onClose }) => {
  if (!trade) return null;

  const isWin = trade.status === 'WIN';
  const isLoss = trade.status === 'LOSS';
  
  // Calculate relative position of exit price vs levels
  const exitPrice = parseFloat(trade.exitPrice || trade.currentPrice || trade.entry);
  const stopLoss = parseFloat(trade.stopLoss);
  const target = parseFloat(trade.target);
  const entry = parseFloat(trade.entry);
  
  const range = target - stopLoss;
  const exitPos = ((exitPrice - stopLoss) / range) * 100;
  const entryPos = ((entry - stopLoss) / range) * 100;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-lg glass-panel border-white/10 bg-slate-900 overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)]">
        {/* Header */}
        <div className={cn(
          "px-6 py-4 border-b border-white/5 flex items-center justify-between",
          isWin ? "bg-green-500/10" : isLoss ? "bg-red-500/10" : "bg-white/5"
        )}>
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-10 h-10 rounded-sm flex items-center justify-center border",
              isWin ? "border-green-500/30 bg-green-500/20 text-green-400" : 
              isLoss ? "border-red-500/30 bg-red-500/20 text-red-400" : "border-white/10 text-white/40"
            )}>
              <BarChart3 className="w-6 h-6" />
            </div>
            <div>
              <div className="text-[12px] font-black text-white/40 uppercase tracking-[0.2em]">Operation Breakdown</div>
              <h2 className="text-xl font-black text-white tracking-tight flex items-center gap-2">
                {trade.symbol.split('-')[0]} // <span className={cn(
                  isWin ? "text-green-400" : isLoss ? "text-red-400" : "text-white/40"
                )}>{trade.status}</span>
              </h2>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
            <X className="w-5 h-5 text-white/40" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Siege Progress Map */}
          <div className="space-y-4">
            <div className="flex justify-between text-[12px] font-black uppercase tracking-widest text-white/50">
              <span>Battle Map Visualization</span>
              <span className="text-cyan-neon/60 font-mono">Range: {((target/stopLoss - 1)*100).toFixed(2)}%</span>
            </div>
            
            <div className="relative h-20 bg-black/40 rounded-sm border border-white/5 p-4 flex flex-col justify-center">
              {/* Central Line */}
              <div className="h-1 w-full bg-white/5 rounded-full relative">
                {/* Entry Marker */}
                <div 
                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-slate-900 rounded-full shadow-[0_0_10px_white] z-10"
                  style={{ left: `${entryPos}%` }}
                />
                {/* Exit Marker */}
                <div 
                  className={cn(
                    "absolute top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-slate-900 rounded-sm z-20 transition-all",
                    isWin ? "bg-green-400 shadow-[0_0_15px_#4ade80]" : "bg-red-400 shadow-[0_0_15px_#f87171]"
                  )}
                  style={{ left: `${exitPos}%` }}
                />
                
                {/* Highlight Zones */}
                <div className="absolute inset-y-0 left-0 bg-red-500/10 rounded-l-full" style={{ width: `${entryPos}%` }} />
                <div className="absolute inset-y-0 bg-green-500/10 rounded-r-full" style={{ left: `${entryPos}%`, width: `${100-entryPos}%` }} />
              </div>
              
              <div className="flex justify-between mt-6 font-mono text-[12px] font-bold">
                <div className="text-red-400/60">
                  <div className="uppercase mb-0.5">STOP</div>
                  <div>${stopLoss}</div>
                </div>
                <div className="text-white">
                  <div className="uppercase mb-0.5">ENTRY</div>
                  <div>${entry}</div>
                </div>
                <div className="text-green-400/60 text-right">
                  <div className="uppercase mb-0.5">TARGET</div>
                  <div>${target}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Tactical Stats Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="glass-panel p-4 space-y-2 border-white/5 bg-white/[0.02]">
              <div className="flex items-center gap-2 text-[12px] font-black text-white/40 uppercase tracking-widest">
                <TrendingUp className="w-3.5 h-3.5" />
                Performance
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">ROI:</span>
                  <span className={cn("font-mono font-bold", isWin ? "text-green-400" : "text-red-400")}>{trade.pnl}%</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Net P&L:</span>
                  <span className={cn("font-mono font-bold", isWin ? "text-green-400" : "text-red-400")}>${trade.usdPnl || '0.00'}</span>
                </div>
              </div>
            </div>

            <div className="glass-panel p-4 space-y-2 border-white/5 bg-white/[0.02]">
              <div className="flex items-center gap-2 text-[12px] font-black text-white/40 uppercase tracking-widest">
                <CircleDollarSign className="w-3.5 h-3.5" />
                Treasury Audit
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Exit Price:</span>
                  <span className="font-mono font-bold text-white">${exitPrice || 'N/A'}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Fees Paid:</span>
                  <span className="font-mono font-bold text-red-400/60">-$2.00</span>
                </div>
              </div>
            </div>
          </div>

          {/* Timing Data */}
          <div className="p-4 glass-panel border-white/5 bg-black/20 flex items-center justify-between">
             <div className="flex items-center gap-3">
               <Clock className="w-4 h-4 text-white/40" />
               <div>
                 <div className="text-[11px] text-white/40 font-black uppercase tracking-widest">Operation Duration</div>
                 <div className="text-[12px] text-white/60 font-mono">
                   {trade.closedAt ? `${Math.floor((trade.closedAt - trade.openedAt) / 60000)} minutes` : 'In progress'}
                 </div>
               </div>
             </div>
             <div className="text-right">
                <div className="text-[11px] text-white/40 font-black uppercase tracking-widest">Resolved At</div>
                <div className="text-[12px] text-white/60 font-mono">
                  {trade.closedAt ? new Date(trade.closedAt).toLocaleTimeString() : 'N/A'}
                </div>
             </div>
          </div>
        </div>

        {/* Footer Rationale */}
        <div className="p-6 bg-black/40 border-t border-white/5">
          <div className="text-[12px] text-cyan-neon/60 font-black uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
            <ShieldAlert className="w-3.5 h-3.5" />
            Vio8 Tactical Post-Mortem
          </div>
          {trade.legacy && (
            <div className="text-[12px] font-bold text-amber-400/80 uppercase tracking-wider mb-2">
              Legacy hold — {trade.legacyDesk === 'pre-meta' ? 'pre-meta record' : `${trade.legacyDesk} desk (removed)`} settled at the last known mark.
            </div>
          )}
          <p className="text-xs text-slate-400 leading-relaxed italic">
            "The siege on {trade.symbol.split('-')[0]} was resolved at ${exitPrice}. {isWin ? 'Capital efficiency remains high. No structural breakdown detected during the move.' : 'The stop loss was triggered to protect the kingdom treasury. Market volatility exceeded our current risk threshold.'}"
          </p>
        </div>
      </div>
    </div>
  );
};
