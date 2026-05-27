/**
 * Token Bucket Rate Limiter
 *
 * Simple per-endpoint rate limiting for RPC calls.
 * Default: 10 requests/second.
 * Handles 429 (rate limited) responses with exponential backoff.
 *
 * Ingestion layer only.
 */

import { createLogger } from '../../telemetry/logging/logger.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('rpc.rateLimiter');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum tokens (requests per second). */
const DEFAULT_MAX_TOKENS = 10;

/** Default refill rate (tokens per second). */
const DEFAULT_REFILL_RATE = 10;

/** Maximum number of retries on 429 rate limit. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** Base backoff delay on 429 (ms). */
const RATE_LIMIT_BASE_DELAY_MS = 1_000;

/** Maximum backoff delay on 429 (ms). */
const RATE_LIMIT_MAX_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefillTimeMs: number;

  constructor(
    maxTokens: number = DEFAULT_MAX_TOKENS,
    refillRate: number = DEFAULT_REFILL_RATE,
  ) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefillTimeMs = Date.now();
  }

  /**
   * Acquire a token. Waits if the bucket is empty.
   * Returns immediately if tokens are available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time for next token
    const waitMs = Math.ceil((1 / this.refillRate) * 1_000);
    logger.debug('Rate limiter waiting for token', { waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    this.refill();
    this.tokens -= 1;
  }

  /**
   * Execute a function with rate limiting and 429 retry.
   * Automatically acquires a token before the call.
   * On 429 or rate-limit error, backs off and retries.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      await this.acquire();

      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;
        const isRateLimit = this.isRateLimitError(err);

        if (!isRateLimit || attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }

        const delay = Math.min(
          RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt),
          RATE_LIMIT_MAX_DELAY_MS,
        );
        logger.warn('Rate limited (429), backing off', {
          attempt: attempt + 1,
          maxRetries: MAX_RATE_LIMIT_RETRIES,
          delayMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTimeMs) / 1_000;
    const tokensToAdd = elapsedSeconds * this.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefillTimeMs = now;
    }
  }

  private isRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return (
        msg.includes('429') ||
        msg.includes('rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('rate_limit')
      );
    }
    return false;
  }
}
