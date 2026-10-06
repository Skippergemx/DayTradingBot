import { useState, useRef, useEffect } from 'react';
import { Send, Terminal, Bot, User } from 'lucide-react';
import { cn } from '../lib/utils';
import { GROQ_API_URL, GROQ_API_KEY } from '../lib/groq';

// The chat desk keeps the cheap brain — banter never needs the advisor's 120b model.
const MODEL = 'openai/gpt-oss-20b';

export const ChatModule = ({ selectedSymbol, marketData, hourlyTrend, trades, kingdomThreat }) => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: `Commander. Vio8 online. I've synced with the ${selectedSymbol} data feed. What are your orders?` }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current && isExpanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isExpanded]);

  const handleSend = async (e) => {
    // ... (rest of handleSend logic stays the same)
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    if (!GROQ_API_KEY) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Uplink key missing — set VITE_GROQ_API_KEY to restore Vio8 comms.' }]);
      return;
    }
    setIsTyping(true);

    try {
      const asset = marketData.find(m => m.symbol === selectedSymbol) || marketData[0];
      const activeTrades = trades.filter(t => t.status === 'OPEN' || t.status === 'PENDING');
      
      const contextPrompt = `
You are Vio8, an Elite Quantitative Scalp Strategist.
CURRENT CONTEXT:
- Asset: ${selectedSymbol}
- Price: $${asset?.price}
- 1H Trend: ${hourlyTrend?.direction || 'Unknown'}
- Kingdom Threat: ${kingdomThreat}
- Active Trades: ${activeTrades.length > 0 ? activeTrades.map(t => `${t.symbol} (${t.status})`).join(', ') : 'None'}

RESPONSE RULES:
1. Speak as Vio8 (Quant persona). 
2. Be brief, tactical, and data-driven.
3. If the user asks about the market, refer to the 'Kingdom Status' (King BTC, Priestess ETH, etc.).
4. Never suggest illegal or non-sharia trading (no leverage, no shorting).`;

      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: contextPrompt },
            ...messages.slice(-5), // Send last 5 messages for context
            { role: "user", content: userMsg }
          ],
          temperature: 0.5,
          reasoning_effort: 'low',        // keep the chat brain cheap — no deep thinks for banter
          max_completion_tokens: 300
        })
      });

      if (!response.ok) {
        const err = new Error(`Groq ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "Signal interference. Please repeat command.";
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (error) {
      console.error("Chat uplink error:", error);
      const throttled = error?.status === 429;
      setMessages(prev => [...prev, { role: 'assistant', content: throttled
        ? "Traffic control has the comms channel throttled. Resend in a moment, Commander."
        : "Error in comms channel. Check API connectivity." }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className={cn(
      "flex flex-col glass-panel border-white/5 bg-black/40 transition-all duration-300 ease-in-out overflow-hidden",
      isExpanded ? "h-[300px]" : "h-[36px] hover:bg-white/5 cursor-pointer"
    )}>
      {/* Header */}
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        className="px-3 py-2 border-b border-white/5 flex items-center justify-between bg-white/[0.02]"
      >
        <div className="flex items-center gap-2">
          <Terminal className={cn("w-3 h-3", isExpanded ? "text-cyan-neon" : "text-cyan-neon/60")} />
          <span className={cn(
            "text-[12px] font-black uppercase tracking-widest font-mono",
            isExpanded ? "text-white/60" : "text-white/40"
          )}>
            Vio8_Comm_Channel {!isExpanded && " — STANDBY"}
          </span>
        </div>
        <div className="flex gap-1 items-center">
          {isExpanded && <div className="text-[10px] text-white/40 font-bold mr-2 uppercase">Minimize</div>}
          <div className={cn(
            "w-1 h-1 rounded-full animate-pulse",
            isExpanded ? "bg-cyan-neon" : "bg-cyan-neon/30"
          )} />
        </div>
      </div>

      {isExpanded && (
        <>
          {/* Message Area */}
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar text-[12px] font-mono"
          >
            {messages.map((msg, i) => (
              <div key={i} className={cn(
                "flex gap-2 max-w-[95%]",
                msg.role === 'user' ? "ml-auto flex-row-reverse text-right" : "mr-auto text-left"
              )}>
                <div className={cn(
                  "shrink-0 w-5 h-5 rounded-sm flex items-center justify-center border",
                  msg.role === 'user' ? "border-white/10 bg-white/5" : "border-cyan-neon/20 bg-cyan-neon/10"
                )}>
                  {msg.role === 'user' ? <User className="w-3 h-3 text-white/40" /> : <Bot className="w-3 h-3 text-cyan-neon" />}
                </div>
                <div className={cn(
                  "p-2 rounded-sm leading-relaxed",
                  msg.role === 'user' ? "bg-white/5 text-white/80" : "bg-cyan-neon/5 text-cyan-neon/90"
                )}>
                  {msg.content}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex gap-2 mr-auto animate-pulse">
                <div className="w-5 h-5 rounded-sm bg-cyan-neon/10 border border-cyan-neon/20 flex items-center justify-center">
                  <Bot className="w-3 h-3 text-cyan-neon" />
                </div>
                <div className="p-2 text-cyan-neon/60 italic">Decrypting incoming signal...</div>
              </div>
            )}
          </div>

          {/* Input Area */}
          <form onSubmit={handleSend} className="p-2 border-t border-white/5 bg-black/20 flex gap-2">
            <input 
              autoFocus
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Transmit order..."
              className="flex-1 bg-white/5 border border-white/10 rounded-sm px-2 py-1 text-[16px] md:text-[12px] text-white focus:outline-none focus:border-cyan-neon/50 placeholder:text-white/35 font-mono transition-all"
            />
            <button 
              type="submit"
              disabled={isTyping}
              className="w-7 h-7 flex items-center justify-center bg-cyan-neon/10 hover:bg-cyan-neon/20 border border-cyan-neon/30 rounded-sm text-cyan-neon transition-all active:scale-95 disabled:opacity-50"
            >
              <Send className="w-3 h-3" />
            </button>
          </form>
        </>
      )}
    </div>
  );
};
