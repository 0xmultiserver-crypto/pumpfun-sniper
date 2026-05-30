/**
 * SOL Price Oracle
 *
 * Fetches SOL/USD price from Jupiter Price API with 60s cache.
 * Falls back to $150 if the API is unreachable.
 *
 * App layer — used by executionDelegate for position sizing.
 *
 * Converted from module-level mutable state to a class instance
 * owned by ServiceContainer for proper DI and testability.
 */

import { createLogger } from '../telemetry/logging/logger.js';
import {
  SOL_FALLBACK_PRICE_USD,
  COINGECKO_PRICE_URL,
  JUPITER_PRICE_URL,
  PRICE_REQUEST_TIMEOUT_MS,
  PRICE_CACHE_TTL_MS,
} from '../core/constants/defaults.js';

const logger = createLogger('app:solPriceOracle');

// ---------------------------------------------------------------------------
// SolPriceOracle
// ---------------------------------------------------------------------------

export class SolPriceOracle {
  private cachedPriceUsd: number;
  private cacheTimestampMs: number;
  private readonly fallbackPriceUsd: number;

  constructor(fallbackPriceUsd?: number) {
    this.fallbackPriceUsd = fallbackPriceUsd ?? SOL_FALLBACK_PRICE_USD;
    this.cachedPriceUsd = this.fallbackPriceUsd;
    this.cacheTimestampMs = 0;
  }

  /**
   * Get the current SOL/USD price.
   *
   * Returns a cached value if fetched within the last 60 seconds.
   * Falls back to the configured fallback price if all sources fail.
   */
  async getSolPriceUsd(): Promise<number> {
    const now = Date.now();

    if (now - this.cacheTimestampMs < PRICE_CACHE_TTL_MS) {
      return this.cachedPriceUsd;
    }

    try {
      const price = await this.fetchSolPrice();
      this.cachedPriceUsd = price;
      this.cacheTimestampMs = now;
      return price;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to fetch SOL price, using fallback', {
        error: msg,
        fallbackUsd: this.fallbackPriceUsd,
      });
      // On failure, still update cache timestamp to avoid hammering the API
      this.cacheTimestampMs = now;
      return this.cachedPriceUsd;
    }
  }

  // -------------------------------------------------------------------------
  // Internal Fetcher
  // -------------------------------------------------------------------------

  private async fetchFromUrl(
    url: string,
    parsePrice: (data: unknown) => number,
  ): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PRICE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: unknown = await response.json();
      const price = parsePrice(data);

      if (typeof price !== 'number' || price <= 0) {
        throw new Error(`Invalid price value: ${String(price)}`);
      }

      return price;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchSolPrice(): Promise<number> {
    // Try CoinGecko first (free, reliable)
    try {
      const price = await this.fetchFromUrl(COINGECKO_PRICE_URL, (data) => {
        const dataObj = data as Record<string, unknown>;
        const solInfo = dataObj['solana'] as Record<string, unknown> | undefined;
        return solInfo?.['usd'] as number;
      });
      logger.debug('SOL price fetched from CoinGecko', { priceUsd: price });
      return price;
    } catch (cgErr: unknown) {
      const cgMsg = cgErr instanceof Error ? cgErr.message : String(cgErr);
      logger.warn('CoinGecko price failed, trying Jupiter', { error: cgMsg });

      // Try Jupiter Price API as fallback
      try {
        const price = await this.fetchFromUrl(JUPITER_PRICE_URL, (data) => {
          const dataObj = data as Record<string, unknown>;
          const dataSection = dataObj['data'] as Record<string, unknown> | undefined;
          const solData = dataSection?.['SOL'] as Record<string, unknown> | undefined;
          return solData?.['price'] as number;
        });
        logger.debug('SOL price fetched from Jupiter', { priceUsd: price });
        return price;
      } catch (jupErr: unknown) {
        const jupMsg = jupErr instanceof Error ? jupErr.message : String(jupErr);
        logger.warn('Jupiter price failed, using fallback', { error: jupMsg });
        throw new Error(`All price sources failed. CoinGecko: ${cgMsg}, Jupiter: ${jupMsg}`);
      }
    }
  }
}
