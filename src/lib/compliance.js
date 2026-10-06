// ── STRICT SHARIA SCREEN — strict-v1 ──────────────────────────────────────────
// A conservative, documented utility screen applied to the scanner universe.
// This is an in-app investment screen, not a religious ruling (fatwa).
//
// Criteria (ALL must hold for an asset to stay in the universe):
//   1. Utility — a working protocol/product or infrastructure network; pure
//      memes with no underlying use-case are excluded.
//   2. Vertical — no gambling, lottery, adult-content or comparable tokens.
//   3. Finance — no interest- or yield-based DeFi products (lending markets,
//      staking-as-a-product, yield aggregators). Spot utility networks are fine.
//   4. Privacy — anonymity-first coins are excluded.
//   5. Securities — no tokenized equity / wrapped securities.
//
// Any criteria or list edit MUST bump SCREEN_VERSION.

export const SCREEN_VERSION = 'strict-v1';

export const SHARIA_CRITERIA = [
  { id: 'utility',    label: 'Real utility — no pure memes' },
  { id: 'vertical',   label: 'No gambling / adult verticals' },
  { id: 'finance',    label: 'No interest- or yield-based DeFi' },
  { id: 'privacy',    label: 'No privacy coins' },
  { id: 'securities', label: 'No tokenized securities' },
];

// Screen-excluded assets — kept here (not only deleted from the universe) so
// every exclusion stays auditable in-app, each with its public reason.
export const EXCLUDED = {
  'PEPE-USDT':  'Pure meme — no underlying utility',
  'DOGE-USDT':  'Pure meme — no underlying utility',
  'WIF-USDT':   'Pure meme — no underlying utility',
  'PRIME-USDT': 'No tradable pair — dead weight on the scanner',
  'AGIX-USDT':  'Merged into FET — duplicate exposure',
  'OCEAN-USDT': 'Merged into FET — duplicate exposure',
};

export const EXCLUDED_BASES = Object.keys(EXCLUDED).map(s => s.split('-')[0]);

/** Screen verdict for a universe symbol: { verdict, note }. */
export const screenStatus = (symbol) => {
  const note = EXCLUDED[symbol];
  return note
    ? { verdict: 'EXCLUDED', note }
    : { verdict: 'COMPLIANT', note: `Passed ${SCREEN_VERSION}` };
};

/** Boolean gate for scanners/filters that only need pass/fail. */
export const isShariaCompliant = (symbol) => !EXCLUDED[symbol];
