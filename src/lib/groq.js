// ── GROQ UPLINK CONFIG ────────────────────────────────────────────────────────
// Single source of truth for the Vio8 AI uplink (advisor + chat module). The key
// lives in the environment — VITE_GROQ_API_KEY in .env.local (local dev) and the
// Vercel project env (deploy) — never in source. A missing key only disables the
// AI narration; the deterministic desks never depend on it.
export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Groq retires model IDs periodically (llama-3.1-8b-instant was decommissioned).
// The advisor chain tries the strongest brain first and degrades gracefully
// instead of going silent; verify current IDs at /openai/v1/models.
export const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

export const GROQ_API_KEY = (import.meta.env && import.meta.env.VITE_GROQ_API_KEY) || '';
if (!GROQ_API_KEY) {
  console.warn('[groq] VITE_GROQ_API_KEY missing — Vio8 uplink disabled. Set it in .env.local (dev) or the Vercel project env (deploy).');
}
