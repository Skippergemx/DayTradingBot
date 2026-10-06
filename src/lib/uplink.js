// ── GROQ UPLINK GOVERNOR (pure) ───────────────────────────────────────────────
// Vio8 talks to one shared Groq org key with per-model ceilings (base tier:
// 30 RPM · 1K RPD · 8K TPM · 200K TPD per gpt-oss model). A 60-second polling
// loop spends a day of quota in under an hour and learns the ceiling through
// 429s — this module is the fix. Three ideas:
//
//   1. PER-MODEL DAILY BUDGET — each model in the chain gets its own token
//      allowance, paced across the day (front-loaded ~25%) so the uplink stays
//      alive from 00:00 to 23:59 instead of burning out by lunch. Two chain
//      models multiply the org envelope: 2 × 120K under 2 × 200K TPD.
//   2. MATERIAL-CHANGE GATE — a quiet tape costs almost nothing: the desk pays
//      for an uplink only when the engine state, the book, or price actually
//      moved (0.5% precision trigger) — plus a slow heartbeat so the read
//      never goes stale for long.
//   3. 429 COOLDOWNS FROM HEADERS — Groq answers a rate-limit with its own
//      reset window (retry-after / x-ratelimit-reset-tokens); the chain cools
//      the offending model for exactly that long instead of hammering it.
//
// Dependency-free on purpose — unit-tested by the Node harness in scripts/.

export const UPLINK = {
  MODEL_DAILY_BUDGET: 120000, // tokens/model/day — 60% of the 200K TPD, leaves air for chat + extra tabs
  MIN_GAP_MS: 150000,         // 2.5-min floor between uplinks, whatever the tape says
  HEARTBEAT_MS: 900000,       // quiet-tape refresh every 15 min (matches the sustainable day pace)
  MODEL_COOLDOWN_MS: 45000,   // 429 floor when no reset header is legible
  COOLDOWN_CAP_MS: 600000,
  SPEND_ESTIMATE: 2600,       // conservative tokens/call when usage is missing
  PRICE_TRIGGER: { ICT_PRECISION: 0.005 }, // precision re-reads on 0.5% moves — other desks inherit the fallback
};

/** Parse a Groq duration header ("7.66s", "1m28.8s", "2m59.56s", "500ms") → ms; null if unreadable. */
export const parseResetMs = (value) => {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)(ms|s))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  const secs = m[2] ? parseFloat(m[2]) : 0;
  return minutes * 60000 + secs * (m[3] === 'ms' ? 1 : 1000);
};

/** 429 cooldown — the longest of retry-after, the tokens reset window, and the floor, capped. */
export const cooldownMs = ({
  retryAfter = null,
  resetTokens = null,
  floor = UPLINK.MODEL_COOLDOWN_MS,
  cap = UPLINK.COOLDOWN_CAP_MS,
}) => {
  const retry = Number.isFinite(parseFloat(retryAfter)) ? parseFloat(retryAfter) * 1000 : 0;
  const reset = parseResetMs(resetTokens) || 0;
  return Math.min(cap, Math.max(floor, retry, reset));
};

/** Stable signature of the open book — a change here is an event worth narrating. */
export const bookKey = (trades = []) => trades
  .filter((t) => t.status === 'OPEN' || t.status === 'PENDING')
  .map((t) => `${t.symbol}:${t.status}`)
  .sort()
  .join(',');

/** UTC-midnight ledger roll — spend resets, cadence memory survives. */
export const rollLedger = (ledger, now) => {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const open = ledger && ledger.dayKey === dayKey;
  return {
    dayKey,
    spent: (open && ledger.spent) || {},
    lastFireAt: (ledger && ledger.lastFireAt) || 0,
  };
};

/** Today's spend allowance, front-loaded ~25% so hours 0-1 aren't choked. */
export const paceAllowance = (now, budget = UPLINK.MODEL_DAILY_BUDGET) => {
  const d = new Date(now);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const hours = (now - dayStart) / 3600000;
  return Math.min(budget, budget * 1.25 * ((hours + 1) / 24));
};

/** Cadence + material-change gate — the desk's answer to "is this worth a token?" */
export const shouldFire = ({
  now, lastFire = 0,
  hidden = false,
  price = 0, lastPrice = 0,
  state = null, lastState = null,
  book = '', lastBook = '',
  strategy = 'ICT_PRECISION',
}) => {
  if (hidden) return { fire: false, reason: 'hidden' };
  if (!lastFire) return { fire: true, reason: 'initial' };
  const gap = now - lastFire;
  if (gap < UPLINK.MIN_GAP_MS) return { fire: false, reason: 'min-gap' };
  if (state && state !== lastState) return { fire: true, reason: 'state' };
  const trigger = UPLINK.PRICE_TRIGGER[strategy] ?? UPLINK.PRICE_TRIGGER.ICT_PRECISION;
  if (lastPrice > 0 && price > 0 && Math.abs(price / lastPrice - 1) >= trigger) return { fire: true, reason: 'price' };
  if (book !== lastBook) return { fire: true, reason: 'book' };
  if (gap >= UPLINK.HEARTBEAT_MS) return { fire: true, reason: 'heartbeat' };
  return { fire: false, reason: 'quiet' };
};

/** The chain, minus models that are cooling or have spent today's allowance. */
export const pickModels = (models, { cooldowns = {}, spent = {} } = {}, now) =>
  models.filter((m) => (cooldowns[m] || 0) <= now && (spent[m] || 0) < paceAllowance(now));
