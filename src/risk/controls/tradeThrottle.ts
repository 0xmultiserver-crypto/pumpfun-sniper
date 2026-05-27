/**
 * Trade Throttle
 *
 * Rate-limits trade attempts to prevent rapid-fire execution
 * caused by signal storms or bugs.
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:tradeThrottle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Throttle check result. */
export interface ThrottleCheckResult {
  /** Whether the trade is allowed. */
  readonly allowed: boolean;
  /** Time until next allowed trade in ms (0 if allowed). */
  readonly waitMs: number;
  /** Number of trades in the current window. */
  readonly tradesInWindow: number;
  /** Reason if not allowed. */
  readonly reason: string | null;
}

/** Configuration. */
export interface TradeThrottleConfig {
  /** Maximum trades per window. Default: 3. */
  readonly maxTradesPerWindow?: number;
  /** Window duration in seconds. Default: 60. */
  readonly windowSeconds?: number;
  /** Minimum gap between trades in seconds. Default: 5. */
  readonly minGapSeconds?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRADES_PER_WINDOW = 3;
const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MIN_GAP_SECONDS = 5;

// ---------------------------------------------------------------------------
// TradeThrottle
// ---------------------------------------------------------------------------

export class TradeThrottle {
  private readonly maxTrades: number;
  private readonly windowMs: number;
  private readonly minGapMs: number;
  private readonly tradeTimestamps: number[] = [];

  constructor(config?: TradeThrottleConfig) {
    this.maxTrades = config?.maxTradesPerWindow ?? DEFAULT_MAX_TRADES_PER_WINDOW;
    this.windowMs = (config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
    this.minGapMs = (config?.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS) * 1000;
  }

  /**
   * Check if a new trade is allowed under rate limits.
   */
  canTrade(): ThrottleCheckResult {
    const now = nowMs();

    // Trim old timestamps outside the window
    const cutoff = now - this.windowMs;
    while (this.tradeTimestamps.length > 0 && this.tradeTimestamps[0]! < cutoff) {
      this.tradeTimestamps.shift();
    }

    // Check window limit
    if (this.tradeTimestamps.length >= this.maxTrades) {
      const oldestInWindow = this.tradeTimestamps[0]!;
      const waitMs = oldestInWindow + this.windowMs - now;

      logger.debug('Trade throttled — window limit', {
        tradesInWindow: this.tradeTimestamps.length,
        maxTrades: this.maxTrades,
        waitMs,
      });

      return {
        allowed: false,
        waitMs: Math.max(0, waitMs),
        tradesInWindow: this.tradeTimestamps.length,
        reason: `Window limit: ${this.tradeTimestamps.length}/${this.maxTrades} trades in ${this.windowMs / 1000}s`,
      };
    }

    // Check minimum gap
    const lastTrade = this.tradeTimestamps[this.tradeTimestamps.length - 1];
    if (lastTrade !== undefined) {
      const elapsed = now - lastTrade;
      if (elapsed < this.minGapMs) {
        const waitMs = this.minGapMs - elapsed;

        logger.debug('Trade throttled — min gap', {
          elapsedMs: elapsed,
          minGapMs: this.minGapMs,
          waitMs,
        });

        return {
          allowed: false,
          waitMs,
          tradesInWindow: this.tradeTimestamps.length,
          reason: `Min gap: ${Math.ceil(waitMs / 1000)}s remaining`,
        };
      }
    }

    return {
      allowed: true,
      waitMs: 0,
      tradesInWindow: this.tradeTimestamps.length,
      reason: null,
    };
  }

  /**
   * Record a trade (call after a trade is executed).
   */
  recordTrade(): void {
    this.tradeTimestamps.push(nowMs());
    logger.debug('Trade recorded in throttle', {
      tradesInWindow: this.tradeTimestamps.length,
    });
  }

  /**
   * Reset the throttle (for testing / emergency).
   */
  reset(): void {
    this.tradeTimestamps.length = 0;
    logger.warn('Trade throttle reset');
  }
}
