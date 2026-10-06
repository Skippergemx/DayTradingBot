// ── ASSET UNIVERSE & EXCHANGE MAPPINGS ───────────────────────────────────────
// Single source of truth for "what the scanner scans". Shared by the live hook
// (useMarketFeed) and the backtest harness (scripts/backtest.mjs) so both always
// run the same universe.

export const SYMBOLS = [
  // ── Core / Blue-chip ────────────────────────────────────────────────────────
  'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'AVAX-USDT', 'NEAR-USDT',
  'LINK-USDT', 'ARB-USDT', 'OP-USDT', 'TIA-USDT', 'SUI-USDT',
  'JUP-USDT', 'SEI-USDT', 'STX-USDT', 'FIL-USDT', 'INJ-USDT',
  'TRX-USDT',
  // ── Strict-screen utility majors (lib/compliance strict-v1 additions) ───────
  'XRP-USDT', 'ADA-USDT', 'DOT-USDT', 'ATOM-USDT', 'ALGO-USDT',
  'XLM-USDT', 'HBAR-USDT', 'VET-USDT', 'APT-USDT', 'AR-USDT',
  'LTC-USDT', 'BCH-USDT', 'UNI-USDT', 'PYTH-USDT',
  // ── 🎮 Gaming (Sharia-compliant utility tokens) ─────────────────────────────
  'SAND-USDT', 'MANA-USDT', 'AXS-USDT', 'GALA-USDT', 'BEAM-USDT',
  'RON-USDT', 'PIXEL-USDT', 'IMX-USDT', 'SUPER-USDT',
  'ILV-USDT', 'YGG-USDT', 'GMT-USDT', 'APE-USDT', 'MAGIC-USDT', 'TLM-USDT',
  // ── 🤖 AI (Sharia-compliant decentralized infrastructure) ───────────────────
  'FET-USDT', 'RNDR-USDT', 'GRT-USDT',
  'TAO-USDT', 'WLD-USDT',
];

export const COINGECKO_IDS = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana',
  'AVAX': 'avalanche-2', 'NEAR': 'near', 'LINK': 'chainlink',
  'ARB': 'arbitrum', 'OP': 'optimism', 'SUI': 'sui',
  'INJ': 'injective-protocol',
  // Strict-screen utility majors
  'XRP': 'ripple', 'ADA': 'cardano', 'DOT': 'polkadot', 'ATOM': 'cosmos',
  'ALGO': 'algorand', 'XLM': 'stellar', 'HBAR': 'hedera-hashgraph',
  'VET': 'vechain', 'APT': 'aptos', 'AR': 'arweave', 'LTC': 'litecoin',
  'BCH': 'bitcoin-cash', 'UNI': 'uniswap', 'PYTH': 'pyth-network',
  'RNDR': 'render-token', 'FET': 'fetch-ai', 'IMX': 'immutable-x',
  // Gaming
  'SAND': 'the-sandbox', 'MANA': 'decentraland', 'AXS': 'axie-infinity',
  'GALA': 'gala', 'BEAM': 'beam-2', 'RON': 'ronin',
  'PIXEL': 'pixels', 'SUPER': 'superfarm',
  'ILV': 'illuvium', 'YGG': 'yield-guild-games', 'GMT': 'stepn',
  'APE': 'apecoin', 'MAGIC': 'magic', 'TLM': 'alien-worlds',
  // AI
  'GRT': 'the-graph', 'TAO': 'bittensor', 'WLD': 'worldcoin-wld',
  'TRX': 'tron',
  'TIA': 'celestia', 'JUP': 'jupiter-exchange-solana', 'SEI': 'sei-network',
  'STX': 'stacks', 'FIL': 'filecoin',
};

// Binance spot aliases — these app tokens trade under a successor symbol on Binance
export const BINANCE_MAP = { RNDR: 'RENDER', BEAM: 'BEAMX', RON: 'RONIN' };
// No Binance USDT pair and no successor symbol — CoinGecko-only (no candles).
// Empty since strict-v1: every universe symbol now has a tradable Binance pair.
export const BINANCE_SKIP = [];
