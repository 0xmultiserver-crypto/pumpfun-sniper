/**
 * Wash Trade Detector
 *
 * Detects suspicious volume patterns that indicate wash trading.
 * Based on ponyin.id concepts:
 *   - Volume tinggi tapi fee sangat kecil = wash trade
 *   - Fee sebanding dengan volume = organic
 *   - Pattern uniformity = suspicious (same amounts, same timing)
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('detectors:washTrade');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the wash trade detector. */
export interface WashTradeDetectorConfig {
  /** Time window in seconds to analyze. Default: 30. */
  readonly windowSeconds?: number;
  /** Minimum trades to analyze. Default: 10. */
  readonly minTradeCount?: number;
  /** Max uniformity ratio (0-1) before flagging. Default: 0.7 (70%). */
  readonly maxUniformityRatio?: number;
  /** Max timing consistency ratio (0-1) before flagging. Default: 0.8 (80%). */
  readonly maxTimingConsistency?: number;
  /** Cooldown per mint in ms before re-emitting. Default: 120_000 (2 min). */
  readonly cooldownMs?: number;
}

/** A single trade event for wash trade analysis. */
export interface WashTradeEvent {
  readonly mint: MintAddress;
  readonly solAmount: bigint;
  readonly timestamp: number;
  readonly slot: number;
}

/** Wash trade analysis result. */
export interface WashTradeResult {
  readonly isSuspicious: boolean;
  readonly score: number; // 0-100, higher = more suspicious
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal state per token
// ---------------------------------------------------------------------------

interface TokenWashState {
  /** Recent trades in the window. */
  trades: Array<{ solAmount: bigint; timestamp: number; slot: number }>;
  /** Last time a wash trade signal was emitted. */
  lastSignalAt: number;
}

// ---------------------------------------------------------------------------
// WashTradeDetector
// ---------------------------------------------------------------------------

export class WashTradeDetector implements IDetector {
  readonly name = 'wash-trade-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly tokenStates = new Map<MintAddress, TokenWashState>();
  private running = false;

  private readonly windowMs: number;
  private readonly minTradeCount: number;
  private readonly maxUniformityRatio: number;
  private readonly maxTimingConsistency: number;
  private readonly cooldownMs: number;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: WashTradeDetectorConfig) {
    this.windowMs = (config?.windowSeconds ?? 30) * 1000;
    this.minTradeCount = config?.minTradeCount ?? 10;
    this.maxUniformityRatio = config?.maxUniformityRatio ?? 0.7;
    this.maxTimingConsistency = config?.maxTimingConsistency ?? 0.8;
    this.cooldownMs = config?.cooldownMs ?? 120_000;
  }

  // -------------------------------------------------------------------------
  // IDetector implementation
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStaleTokens();
    }, 30_000);

    logger.info('Wash trade detector started', {
      windowMs: this.windowMs,
      minTradeCount: this.minTradeCount,
      maxUniformityRatio: this.maxUniformityRatio,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenStates.clear();
    logger.info('Wash trade detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get the latest wash trade score for a mint.
   * Returns 0-100 (higher = more suspicious), or null if no data.
   */
  getLatestWashScore(mint: string): number | null {
    const state = this.tokenStates.get(mint as MintAddress);
    if (!state || state.trades.length < 5) return null;
    const result = this.analyzeWashPattern(state.trades);
    return result.score;
  }

  /**
   * Force-analyze wash trade patterns for a mint.
   * Returns 0-100 (higher = more suspicious), or 0 if no data.
   * Unlike getLatestWashScore, this works with as few as 2 trades.
   */
  forceAnalyze(mint: string): number {
    const state = this.tokenStates.get(mint as MintAddress);
    if (!state || state.trades.length < 2) return 0;
    const result = this.analyzeWashPattern(state.trades);
    return result.score;
  }

  // -------------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -------------------------------------------------------------------------

  /**
   * Process a trade event for wash trade detection.
   * Analyzes both buy and sell events for pattern uniformity.
   */
  handleTrade(event: WashTradeEvent): void {
    if (!this.running) return;

    let state = this.tokenStates.get(event.mint);
    if (state === undefined) {
      state = { trades: [], lastSignalAt: 0 };
      this.tokenStates.set(event.mint, state);
    }

    // Add trade
    state.trades.push({
      solAmount: event.solAmount,
      timestamp: event.timestamp,
      slot: event.slot,
    });

    // Trim expired trades
    const cutoff = nowMs() - this.windowMs;
    state.trades = state.trades.filter((t) => t.timestamp >= cutoff);

    // Need minimum trades to analyze
    if (state.trades.length < this.minTradeCount) return;

    // Analyze patterns
    const result = this.analyzeWashPattern(state.trades);

    if (result.isSuspicious && result.score >= 70) {
      const now = nowMs();
      if (now - state.lastSignalAt >= this.cooldownMs) {
        state.lastSignalAt = now;

        logger.warn('Wash trade pattern detected', {
          mint: event.mint.slice(0, 12),
          score: result.score,
          reasons: result.reasons,
          tradeCount: state.trades.length,
        });

        this.emitWashSignal(event.mint, result.score, result.reasons, event.slot);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  private analyzeWashPattern(
    trades: Array<{ solAmount: bigint; timestamp: number; slot: number }>,
  ): WashTradeResult {
    const reasons: string[] = [];
    let score = 0;

    // 1. Amount uniformity check
    // If many trades have the exact same amount, it's suspicious
    const amountCounts = new Map<string, number>();
    for (const trade of trades) {
      const key = trade.solAmount.toString();
      amountCounts.set(key, (amountCounts.get(key) ?? 0) + 1);
    }

    let maxSameAmount = 0;
    for (const count of amountCounts.values()) {
      if (count > maxSameAmount) maxSameAmount = count;
    }

    const uniformityRatio = maxSameAmount / trades.length;
    if (uniformityRatio > this.maxUniformityRatio) {
      score += 40;
      reasons.push(
        `Amount uniformity: ${(uniformityRatio * 100).toFixed(0)}% trades have same amount (max: ${(this.maxUniformityRatio * 100).toFixed(0)}%)`,
      );
    }

    // 2. Timing consistency check
    // If trades happen at very regular intervals, it's suspicious (bot-like)
    if (trades.length >= 3) {
      const intervals: number[] = [];
      for (let i = 1; i < trades.length; i++) {
        const curr = trades[i];
        const prev = trades[i - 1];
        if (curr && prev) {
          intervals.push(curr.timestamp - prev.timestamp);
        }
      }

      // Calculate coefficient of variation (CV) of intervals
      // Low CV = very consistent timing = suspicious
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (mean > 0) {
        const variance =
          intervals.reduce((sum, val) => sum + (val - mean) ** 2, 0) /
          intervals.length;
        const stdDev = Math.sqrt(variance);
        const cv = stdDev / mean;

        // CV < 0.2 means very consistent timing
        if (cv < 1 - this.maxTimingConsistency) {
          score += 30;
          reasons.push(
            `Timing consistency: CV=${cv.toFixed(3)} (suspicious if <${(1 - this.maxTimingConsistency).toFixed(1)})`,
          );
        }
      }
    }

    // 3. Volume burst check
    // If all volume came in a very short burst, it's suspicious
    if (trades.length >= 5) {
      const lastTrade = trades[trades.length - 1];
      const firstTrade = trades[0];
      if (lastTrade && firstTrade) {
        const timeSpan = lastTrade.timestamp - firstTrade.timestamp;
        const volumeConcentration = trades.length / Math.max(timeSpan / 1000, 1);

        // More than 5 trades per second is suspicious
        if (volumeConcentration > 5) {
          score += 30;
          reasons.push(
            `Volume burst: ${volumeConcentration.toFixed(1)} trades/sec (suspicious if >5)`,
          );
        }
      }
    }

    // 4. Slot concentration check
    // If many trades from very few slots, it's suspicious
    const uniqueSlots = new Set(trades.map((t) => t.slot));
    const slotConcentration = trades.length / uniqueSlots.size;
    if (slotConcentration > 3 && uniqueSlots.size <= 2) {
      score += 20;
      reasons.push(
        `Slot concentration: ${slotConcentration.toFixed(1)} trades/slot from ${uniqueSlots.size} slots`,
      );
    }

    return {
      isSuspicious: score >= 70,
      score: Math.min(score, 100),
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emitWashSignal(
    mint: MintAddress,
    score: number,
    reasons: readonly string[],
    slot: number,
  ): void {
    const signal: import('../../core/types/signal.js').WashTradeSignal = {
      id: `wash-${slot}-${nowMs()}`,
      type: 'WASH_TRADE',
      mint,
      timestamp: nowMs(),
      slot,
      washScore: score,
      washReasons: reasons,
    };

    logger.info('Wash trade signal emitted', {
      signalId: signal.id,
      mint,
      score,
      reasons,
    });

    for (const handler of this.handlers) {
      try {
        handler(signal);
      } catch (err: unknown) {
        logger.error('Signal handler threw', {
          signalId: signal.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private purgeStaleTokens(): void {
    const cutoff = nowMs() - this.windowMs * 2;
    for (const [mint, state] of this.tokenStates) {
      const latestTrade = state.trades[state.trades.length - 1];
      if (latestTrade === undefined || latestTrade.timestamp < cutoff) {
        this.tokenStates.delete(mint);
      }
    }
  }
}
