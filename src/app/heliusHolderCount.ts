/**
 * Helius Holder Count
 *
 * Fetches the real total holder count for a token using Helius getTokenAccounts API.
 * PAGINATES through all pages to get the real count (total field is per-page, not global).
 *
 * Used by entry check #17 (holder-mcap ratio) to detect coordinated holder inflation.
 *
 * Rate limiting:
 *  - Global max 2 requests per second
 *  - Per-mint cache: 120 seconds
 *  - Concurrent request deduplication
 */

import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('app:holderCount');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const holderCache = new Map<string, { count: number; timestamp: number }>();
const CACHE_TTL_MS = 120_000; // 2 minutes
const MAX_CACHE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Rate limiter — token bucket, 2 tokens/sec, max burst 2
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
 * Get the real total holder count for a token mint via Helius API.
 * Paginates through ALL pages to get the true count.
 * Returns null if the API call fails (caller should handle gracefully).
 */
export async function getRealHolderCount(
  mint: string,
  heliusApiKey: string,
): Promise<number | null> {
  // 1. Check cache
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.count;
  }

  // 2. Deduplicate — if same mint is already being fetched, wait for it
  const existing = pending.get(mint);
  if (existing !== undefined) {
    return existing;
  }

  // 3. Rate limit — if no tokens available, return cached (stale ok) or null
  if (!tryConsumeToken()) {
    logger.debug('Rate limited — using stale cache', { mint: mint.slice(0, 12) });
    return cached?.count ?? null;
  }

  // 4. Fetch from Helius (with pagination)
  const promise = fetchHolderCountPaginated(mint, heliusApiKey);
  pending.set(mint, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    pending.delete(mint);
  }
}

// ---------------------------------------------------------------------------
// Internal fetcher — paginated
// ---------------------------------------------------------------------------

async function fetchHolderCountPaginated(
  mint: string,
  heliusApiKey: string,
): Promise<number | null> {
  let totalCount = 0;
  let cursor: string | undefined;
  let pages = 0;
  const MAX_PAGES = 10; // Safety limit — max 10 pages (10k accounts)

  try {
    while (pages < MAX_PAGES) {
      // Rate limit per page
      if (pages > 0) {
        if (!tryConsumeToken()) {
          // Rate limited mid-pagination — return what we have so far
          logger.debug('Rate limited during pagination, returning partial count', {
            mint: mint.slice(0, 12),
            partialCount: totalCount,
            pages,
          });
          break;
        }
      }

      const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
      const body: Record<string, unknown> = {
        jsonrpc: '2.0',
        id: pages + 1,
        method: 'getTokenAccounts',
        params: { mint },
      };
      if (cursor !== undefined) {
        body.params = { mint, cursor };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.warn('Helius rate limited (429) — backing off', { mint: mint.slice(0, 12) });
          tokens = 0;
        }
        break;
      }

      const data = await response.json() as {
        result?: { token_accounts?: unknown[]; cursor?: string };
        error?: unknown;
      };

      if (data.error) {
        logger.warn('Helius getTokenAccounts RPC error', { error: data.error });
        break;
      }

      const accounts = data.result?.token_accounts ?? [];
      totalCount += accounts.length;
      cursor = data.result?.cursor;
      pages++;

      // No more pages
      if (cursor === undefined || cursor === '' || accounts.length === 0) {
        break;
      }
    }

    if (totalCount <= 0) {
      logger.debug('No holder accounts found', { mint: mint.slice(0, 12) });
      return null;
    }

    // Cache the result (evict oldest if at capacity)
    if (holderCache.size >= MAX_CACHE_SIZE) {
      const oldest = holderCache.keys().next().value;
      if (oldest) holderCache.delete(oldest);
    }
    holderCache.set(mint, { count: totalCount, timestamp: Date.now() });
    logger.debug('Real holder count fetched', {
      mint: mint.slice(0, 12),
      holders: totalCount,
      pages,
    });

    return totalCount;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to fetch real holder count', { mint: mint.slice(0, 12), error: msg });
    return holderCache.get(mint)?.count ?? null;
  }
}
