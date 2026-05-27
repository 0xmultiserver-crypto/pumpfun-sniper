/**
 * Default configuration values.
 *
 * LOCKED values from rule.md. No arbitrary changes without approval.
 * Every constant here is sourced from the project constitution.
 *
 * This is the single source of truth. filteredSniperRules.ts imports
 * and re-exports these values (with strategy-layer naming conventions).
 *
 * Convention: DEFAULT_STOP_LOSS_PCT is POSITIVE (50). The exit evaluator
 * negates it internally: `pnlPercent <= -stopLossPct`. In contrast,
 * filteredSniperRules.STOP_LOSS_PERCENT is NEGATIVE (-50).
 */

import type { ComputeBudgetParams } from '../types/execution.js';

/** Position sizing — base $1 equivalent (dynamic sizing center point) */
export const DEFAULT_POSITION_SIZE_USD = 1 as const;

/** Dynamic position sizing — minimum $0.50 */
export const DEFAULT_MIN_POSITION_SIZE_USD = 0.5 as const;

/** Dynamic position sizing — maximum $5.00 */
export const DEFAULT_MAX_POSITION_SIZE_USD = 5 as const;

/** Dynamic position sizing — base (center) $1.00 */
export const DEFAULT_BASE_POSITION_SIZE_USD = 1 as const;

/** Take profit — LOCKED: +1500% */
export const DEFAULT_TAKE_PROFIT_PCT = 1500 as const;

/** Stop loss — LOCKED: -50% */
export const DEFAULT_STOP_LOSS_PCT = 50 as const;

/** Trailing stop — activates after this % profit from entry. 0 = always active. */
export const DEFAULT_TRAILING_ACTIVATION_PCT = 30 as const;

/** Trailing stop — drops this % from highest price to trigger sell. 0 = disabled. */
export const DEFAULT_TRAILING_STOP_PCT = 25 as const;

/** Timeout — LOCKED: 60 minutes (3600 seconds) */
export const DEFAULT_TIMEOUT_SECONDS = 3600 as const;

/** Max concurrent positions — LOCKED: 1 */
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 1 as const;

/** Momentum entry filter — LOCKED: minimum buy count in the configured window */
export const DEFAULT_MOMENTUM_MIN_BUYS = 7 as const;

/** Momentum entry filter — LOCKED: buy-count window in seconds */
export const DEFAULT_MOMENTUM_WINDOW_SECONDS = 15 as const;

/** Momentum entry filter — LOCKED: minimum buy volume in lamports */
export const DEFAULT_MOMENTUM_MIN_VOLUME_LAMPORTS = 1_000_000_000n as const;

/** Creator history entry filter — LOCKED: lookback window in seconds */
export const DEFAULT_CREATOR_HISTORY_WINDOW_SECONDS = 3_600 as const;

/** Creator history entry filter — LOCKED: max recent launches by same creator */
export const DEFAULT_CREATOR_HISTORY_MAX_LAUNCHES = 2 as const;

/** Daily kill switch — LOCKED: -$40 */
export const DEFAULT_DAILY_KILL_LIMIT_USD = 40 as const;

/** Cooldown after stop loss — 2 minutes (120 seconds) */
export const DEFAULT_COOLDOWN_AFTER_SL_SECONDS = 120 as const;

/** Default slippage in basis points */
// ---------------------------------------------------------------------------
// SOL Price Oracle Constants
// ---------------------------------------------------------------------------

/** Fallback SOL/USD price if all sources fail. */
export const SOL_FALLBACK_PRICE_USD = 150 as const;

/** Jupiter Price API for SOL. */
export const JUPITER_PRICE_URL = 'https://price.jup.ag/v6/price?ids=SOL' as const;

/** CoinGecko fallback for SOL price. */
export const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd' as const;

/** Price request timeout in milliseconds. */
export const PRICE_REQUEST_TIMEOUT_MS = 5_000 as const;

/** Price cache TTL in milliseconds (60 seconds). */
export const PRICE_CACHE_TTL_MS = 60_000 as const;

/** Default slippage in basis points */
export const DEFAULT_SLIPPAGE_BPS = 500 as const;

/** Default log level */
export const DEFAULT_LOG_LEVEL = 'info' as const;

// ---------------------------------------------------------------------------
// Shared Entry Check Constants (deduplicated from dataProvider + heuristics)
// ---------------------------------------------------------------------------

/** Minimum virtual SOL reserves on bonding curve (0.1 SOL) */
export const DEFAULT_MIN_SOL_RESERVES = 100_000_000n as const;

/** Minimum virtual token reserves on bonding curve */
export const DEFAULT_MIN_TOKEN_RESERVES = 1_000_000n as const;

/** Minimum acceptable token name length */
export const DEFAULT_MIN_NAME_LENGTH = 1 as const;

/** Maximum acceptable token name length */
export const DEFAULT_MAX_NAME_LENGTH = 50 as const;

/** Minimum acceptable token symbol length */
export const DEFAULT_MIN_SYMBOL_LENGTH = 1 as const;

/** Maximum acceptable token symbol length */
export const DEFAULT_MAX_SYMBOL_LENGTH = 12 as const;

/** Scam patterns in token names/symbols (case-insensitive, financial scams) */
export const DEFAULT_METADATA_SCAM_PATTERNS: readonly RegExp[] = [
  /rug/i, /scam/i, /honeypot/i, /ponzi/i, /fake/i,
  /airdrop.*claim/i, /connect.*wallet/i, /seed.*phrase/i,
  /private.*key/i, /send.*sol.*back/i, /doubler/i,
  /guaranteed/i, /free.*sol/i,
] as const;

/** Structural metadata patterns (keyboard mash, test, repeated chars) */
export const DEFAULT_METADATA_STRUCTURAL_PATTERNS: readonly RegExp[] = [
  /^\s*$/,        // Whitespace-only name
  /^test\d*$/i,   // "test", "test123"
  /^asdf/i,       // Keyboard mash
  /^aaa+$/i,      // Repeated characters
] as const;

/** Wallet concentration: max % top N holders can own (0-100) */
export const DEFAULT_MAX_WALLET_CONCENTRATION_PCT = 80 as const;

/** Wallet concentration: number of top holders to check */
export const DEFAULT_WALLET_CONCENTRATION_TOP_N = 5 as const;

/** Momentum detector cooldown per mint in ms before re-emitting */
export const DEFAULT_MOMENTUM_COOLDOWN_MS = 60_000 as const;

/** Max price impact before buy — LOCKED: 500 bps (5%) */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 500 as const;

/** Momentum detector max tokens to track simultaneously */
export const DEFAULT_MOMENTUM_MAX_TRACKED_TOKENS = 500 as const;

// ---------------------------------------------------------------------------
// Scale-Out Exit Strategy
// ---------------------------------------------------------------------------

/** Scale-out partial selling — enabled by default. */
export const DEFAULT_SCALE_OUT_ENABLED = true as const;

/**
 * Scale-out tiers. Each tier defines a profit-percentage trigger and the
 * percentage of the current token balance to sell at that trigger.
 *
 * Default tiers:
 *   +100% → sell 50% of position
 *   +300% → sell 25% of position
 *   Remaining rides with trailing stop.
 */
export const DEFAULT_SCALE_OUT_TIERS: ReadonlyArray<{ readonly triggerPct: number; readonly sellPct: number }> = [
  { triggerPct: 100, sellPct: 50 },
  { triggerPct: 300, sellPct: 25 },
] as const;

/** Max transaction retry attempts */
export const DEFAULT_MAX_TX_RETRIES = 2 as const;

// ---------------------------------------------------------------------------
// Jito MEV Protection
// ---------------------------------------------------------------------------

/**
 * Default Jito tip amount in lamports.
 * 10,000 lamports = 0.00001 SOL.
 * Adjust based on network conditions / desired inclusion priority.
 */
export const JITO_TIP_LAMPORTS = 10_000 as const;

/** Delay between transaction retries in ms */
export const DEFAULT_TX_RETRY_DELAY_MS = 1_000 as const;

// ---------------------------------------------------------------------------
// Anti-Rug Mechanism Constants
// ---------------------------------------------------------------------------

/** Anti-rug monitor enabled by default. */
export const DEFAULT_ANTI_RUG_ENABLED = true as const;

/** Emergency exit if any top holder dumps > this % of total supply. */
export const DEFAULT_RUG_DUMP_THRESHOLD_PCT = 10 as const;

/** How often to poll top holders during an active position (ms). */
export const DEFAULT_RUG_CHECK_INTERVAL_MS = 5_000 as const;

// ---------------------------------------------------------------------------
// WebSocket connection defaults
// ---------------------------------------------------------------------------

/** Maximum number of consecutive reconnection attempts before giving up. */
export const DEFAULT_WS_MAX_RETRIES = 10 as const;

/** Base delay for exponential backoff (ms). */
export const DEFAULT_WS_BASE_DELAY_MS = 5_000 as const;

/** Maximum delay between retries (ms). */
export const DEFAULT_WS_MAX_DELAY_MS = 60_000 as const;

/** WebSocket connection timeout (ms). */
export const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000 as const;

// ---------------------------------------------------------------------------
// Compute budget defaults
// ---------------------------------------------------------------------------

/** Default compute budget for Pump.fun buy/sell (generous). */
export const DEFAULT_PUMPFUN_COMPUTE_BUDGET: ComputeBudgetParams = {
  computeUnitLimit: 200_000,
  computeUnitPrice: 150_000n, // 150k micro-lamports/CU
} as const;

/** Default compute budget for Jupiter swap (higher CU needed). */
export const DEFAULT_JUPITER_COMPUTE_BUDGET: ComputeBudgetParams = {
  computeUnitLimit: 400_000,
  computeUnitPrice: 150_000n,
} as const;

// ---------------------------------------------------------------------------
// RPC defaults
// ---------------------------------------------------------------------------

/** Helius RPC base URL. */
export const DEFAULT_HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com' as const;

/** Alchemy RPC base URL. */
export const DEFAULT_ALCHEMY_RPC_BASE = 'https://solana-mainnet.g.alchemy.com/v2' as const;

/** Helius RPC timeout (ms). */
export const DEFAULT_RPC_HELIUS_TIMEOUT_MS = 10_000 as const;

/** PublicNode RPC timeout (ms) — public = slower, give more time. */
export const DEFAULT_RPC_PUBLICNODE_TIMEOUT_MS = 15_000 as const;

/** Alchemy RPC timeout (ms). */
export const DEFAULT_RPC_ALCHEMY_TIMEOUT_MS = 12_000 as const;

// ---------------------------------------------------------------------------
// Database pool defaults
// ---------------------------------------------------------------------------

/** PostgreSQL max pool connections. */
export const DEFAULT_DB_MAX_CONNECTIONS = 5 as const;

/** PostgreSQL idle timeout (ms). */
export const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000 as const;

/** PostgreSQL connection timeout (ms). */
export const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 10_000 as const;


