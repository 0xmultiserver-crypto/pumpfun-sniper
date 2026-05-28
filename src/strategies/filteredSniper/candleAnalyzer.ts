/**
 * Candle Analyzer — Phase 5.1: 3-Candle Confirmation Exit
 *
 * Tracks OHLC candle patterns from bonding curve price data and emits
 * exit signals when bearish candle sequences are confirmed.
 *
 * Design:
 *   - Pure in-memory candle history (last 20 candles per mint)
 *   - No RPC, no I/O — strategy-only module
 *   - Prometheus counter for exit signal observability
 *
 * Rules:
 *   1. First red candle + volume drop  → WATCH (don't panic sell)
 *   2. 3 consecutive red candles + volume increase → EXIT signal
 *   3. Green candle after red → reset consecutive-red counter
 */

import { Counter } from 'prom-client';
import type { MintAddress } from '../../core/types/token.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('strategy:candleAnalyzer');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const candleExitSignalsTotal = new Counter({
  name: 'pumpfun_candle_exit_signals_total',
  help: 'Total 3-candle confirmation exit signals emitted',
  labelNames: ['signal'] as const, // 'exit' | 'watch'
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OHLC candle data derived from bonding curve price observations. */
export interface CandleData {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly timestamp: number;
}

/** Result of candle-pattern exit analysis. */
export interface ExitSignalAnalysis {
  /** Whether an exit signal has been confirmed (3 red + rising volume). */
  readonly shouldExit: boolean;
  /** Human-readable reason for the signal. */
  readonly reason: string;
  /** Number of candles recorded for this mint. */
  readonly candleCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a candle is "red" (bearish).
 * A candle is red when the close is below the open.
 */
function isCandleRed(candle: CandleData): boolean {
  return candle.close < candle.open;
}

// ---------------------------------------------------------------------------
// CandleAnalyzer
// ---------------------------------------------------------------------------

/** Maximum candles kept per mint in memory. */
const MAX_CANDLES_PER_MINT = 20;

/**
 * Analyses OHLC candle patterns to produce exit signals for positions.
 *
 * Thread-safe by convention: single-threaded Node.js event loop.
 * Memory-bounded: evicts oldest candles beyond the 20-candle window.
 */
export class CandleAnalyzer {
  /** Per-mint candle history (most recent last). */
  private readonly history: Map<MintAddress, CandleData[]> = new Map();

  /**
   * Append a candle to the mint's history.
   * Evicts the oldest candle when the buffer exceeds MAX_CANDLES_PER_MINT.
   */
  recordCandle(mint: MintAddress, candle: CandleData): void {
    let candles = this.history.get(mint);
    if (candles === undefined) {
      candles = [];
      this.history.set(mint, candles);
    }

    candles.push(candle);

    // Evict oldest if over capacity
    if (candles.length > MAX_CANDLES_PER_MINT) {
      candles.shift();
    }

    logger.debug('Recorded candle', {
      mint,
      open: candle.open,
      close: candle.close,
      volume: candle.volume,
      red: isCandleRed(candle),
      candleCount: candles.length,
    });
  }

  /**
   * Analyse the most recent candles for a mint and determine whether an
   * exit signal should be emitted.
   *
   * Logic:
   *   - Walk backwards from the newest candle.
   *   - Count consecutive red candles.
   *   - If a green candle is encountered, the consecutive-red counter resets.
   *   - Volume is compared between consecutive candles:
   *       * First red + volume drop  → WATCH (informational, no exit)
   *       * 3 consecutive red + volume rising → EXIT
   *
   * Returns immediately with shouldExit=false if fewer than 3 candles exist.
   */
  analyzeExitSignal(mint: MintAddress): ExitSignalAnalysis {
    const candles = this.history.get(mint);
    const candleCount = candles?.length ?? 0;

    if (candles === undefined || candles.length < 3) {
      return {
        shouldExit: false,
        reason: candleCount === 0
          ? 'No candles recorded yet'
          : `Only ${candleCount} candle(s) — need at least 3 for analysis`,
        candleCount,
      };
    }

    // Work with the last 3 candles
    const last3 = candles.slice(-3) as [CandleData, CandleData, CandleData];
    const [c1, c2, c3] = last3; // c1 oldest, c3 newest of the window

    const red1 = isCandleRed(c1);
    const red2 = isCandleRed(c2);
    const red3 = isCandleRed(c3);

    // --- Rule 3: Green candle after red resets counter ---
    // If the most recent candle is green, any prior red streak is broken.
    if (!red3) {
      logger.debug('Most recent candle is green — resetting red streak', { mint });
      return {
        shouldExit: false,
        reason: 'Most recent candle is green — red streak reset',
        candleCount,
      };
    }

    // At this point c3 is red.

    // --- Rule 1: First red candle with volume drop → WATCH ---
    // If c2 was green and c3 is the first red with lower volume, just watch.
    if (!red2 && red3 && c3.volume < c2.volume) {
      logger.info('First red candle with volume drop — WATCH mode', {
        mint,
        prevVolume: c2.volume,
        currVolume: c3.volume,
      });
      candleExitSignalsTotal.inc({ signal: 'watch' });
      return {
        shouldExit: false,
        reason: 'First red candle with volume drop — watching, not selling',
        candleCount,
      };
    }

    // --- Rule 2: 3 consecutive red candles + volume increasing → EXIT ---
    if (red1 && red2 && red3) {
      // Volume must be increasing: c3.volume > c2.volume > c1.volume
      const volumeIncreasing = c3.volume > c2.volume && c2.volume > c1.volume;

      if (volumeIncreasing) {
        logger.warn('EXIT signal: 3 consecutive red candles with rising volume', {
          mint,
          volumes: [c1.volume, c2.volume, c3.volume],
          closes: [c1.close, c2.close, c3.close],
        });
        candleExitSignalsTotal.inc({ signal: 'exit' });
        return {
          shouldExit: true,
          reason:
            `3 consecutive red candles with rising volume ` +
            `(volumes: ${c1.volume.toFixed(2)} → ${c2.volume.toFixed(2)} → ${c3.volume.toFixed(2)})`,
          candleCount,
        };
      }

      // 3 red candles but volume NOT rising — warn but don't exit
      logger.info('3 red candles but volume not increasing — continue watching', {
        mint,
        volumes: [c1.volume, c2.volume, c3.volume],
      });
      candleExitSignalsTotal.inc({ signal: 'watch' });
      return {
        shouldExit: false,
        reason:
          `3 red candles but volume not consistently increasing ` +
          `(volumes: ${c1.volume.toFixed(2)}, ${c2.volume.toFixed(2)}, ${c3.volume.toFixed(2)})`,
        candleCount,
      };
    }

    // Fewer than 3 consecutive red candles — no signal
    logger.debug('No exit signal — fewer than 3 consecutive red candles', { mint });
    return {
      shouldExit: false,
      reason: `${red1 && red2 ? 2 : red1 ? 1 : 0} consecutive red candle(s) — below threshold`,
      candleCount,
    };
  }

  /**
   * Get the candle history for a mint (read-only snapshot).
   * Useful for debugging and metrics endpoints.
   */
  getCandles(mint: MintAddress): readonly CandleData[] {
    return Object.freeze([...(this.history.get(mint) ?? [])]);
  }

  /**
   * Clear the candle history for a mint (e.g. after position is closed).
   */
  clearMint(mint: MintAddress): void {
    this.history.delete(mint);
    logger.debug('Cleared candle history', { mint });
  }
}
