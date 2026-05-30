/**
 * Real Volume Fetcher
 *
 * Fetches real 1h volume for a token from DexScreener API.
 * Used by entry check #18 (volume-mcap ratio) to detect wash trade.
 *
 * Rate limiting:
 *  - Global max 2 requests per second
 *  - Per-mint cache: 120 seconds
 *  - Concurrent request deduplication
 */

import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('app:realVolume');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const volumeCache = new Map<string, { volumeUsd: number; timestamp: number }>();
const CACHE_TTL_MS = 120_000; // 2 minutes
const MAX_CACHE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const RATE_LIMIT_RPS = 2;
const RATE_LIMIT_BURST = 2;
let tokens = RATE_LIMIT_BURST;
let lastRefill = Date.now();

function refillTokens(): void {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(RATE_LIMIT_BURST, tokens + elapsed * RATE_LIMIT_RPS);
  lastRefill = now;
}

function tryConsumeToken(): boolean {
  refillTokens();
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pending requests — deduplicate concurrent calls for the same mint
// ---------------------------------------------------------------------------

const pending = new Map<string, Promise<number | null>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get real 1h volume in USD for a token mint via DexScreener API.
 * Returns null if the API call fails.
 */
export async function getRealVolume1h(
  mint: string,
): Promise<number | null> {
  // 1. Check cache
  const cached = volumeCache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.volumeUsd;
  }

  // 2. Deduplicate
  const existing = pending.get(mint);
  if (existing !== undefined) {
    return existing;
  }

  // 3. Rate limit
  if (!tryConsumeToken()) {
    logger.debug('Rate limited — using stale cache', { mint: mint.slice(0, 12) });
    return cached?.volumeUsd ?? null;
  }

  // 4. Fetch
  const promise = fetchVolume(mint);
  pending.set(mint, promise);

  try {
    return await promise;
  } finally {
    pending.delete(mint);
  }
}

// ---------------------------------------------------------------------------
// Internal fetcher
// ---------------------------------------------------------------------------

async function fetchVolume(mint: string): Promise<number | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        logger.warn('DexScreener rate limited (429)', { mint: mint.slice(0, 12) });
        tokens = 0;
      }
      return volumeCache.get(mint)?.volumeUsd ?? null;
    }

    const data = await response.json() as { pairs?: Array<{ volume?: { h1?: number } }> };
    const pair = data.pairs?.[0];
    if (!pair) {
      logger.debug('No pair found on DexScreener', { mint: mint.slice(0, 12) });
      return null;
    }

    const volume1h = pair.volume?.h1 ?? 0;

    // Cache (evict oldest if at capacity)
    if (volumeCache.size >= MAX_CACHE_SIZE) {
      const oldest = volumeCache.keys().next().value;
      if (oldest) volumeCache.delete(oldest);
    }
    volumeCache.set(mint, { volumeUsd: volume1h, timestamp: Date.now() });
    logger.debug('Real volume fetched', { mint: mint.slice(0, 12), volume1h });

    return volume1h;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to fetch real volume', { mint: mint.slice(0, 12), error: msg });
    return volumeCache.get(mint)?.volumeUsd ?? null;
  }
}
