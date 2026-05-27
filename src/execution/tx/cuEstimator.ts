/**
 * Dynamic Compute Unit Estimator
 *
 * Tracks actual compute units consumed per transaction type and provides
 * an adaptive CU limit that converges to real usage + 20% buffer.
 *
 * Design:
 *   - Rolling window of the last N=20 data points per transaction type
 *   - Falls back to DEFAULT_CU_LIMIT (200,000) until MIN_SAMPLES (5) observed
 *   - After that, uses (rolling average * 1.2) clamped to [100_000, 1_400_000]
 *   - Thread-safe (no async, pure in-memory state)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default CU limit when not enough data points exist. */
const DEFAULT_CU_LIMIT = 200_000;

/** Minimum number of data points before using rolling average. */
const MIN_SAMPLES = 5;

/** Safety buffer multiplier applied to rolling average. */
const BUFFER_MULTIPLIER = 1.2;

/** Rolling window size per transaction type. */
const WINDOW_SIZE = 20;

/** Absolute minimum CU limit. */
const MIN_CU_LIMIT = 100_000;

/** Absolute maximum CU limit (Solana runtime cap). */
const MAX_CU_LIMIT = 1_400_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Transaction type for CU tracking. */
export type CuTxType = 'BUY' | 'SELL';

// ---------------------------------------------------------------------------
// CUEstimator
// ---------------------------------------------------------------------------

export class CUEstimator {
  private readonly history: Map<CuTxType, number[]> = new Map();

  /**
   * Get the estimated CU limit for a transaction type.
   *
   * - If fewer than MIN_SAMPLES data points: returns DEFAULT_CU_LIMIT.
   * - Otherwise: returns rolling average * BUFFER_MULTIPLIER, clamped.
   */
  estimateCu(type: CuTxType): number {
    const samples = this.history.get(type);
    if (!samples || samples.length < MIN_SAMPLES) {
      return DEFAULT_CU_LIMIT;
    }

    const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const estimated = Math.ceil(avg * BUFFER_MULTIPLIER);
    return clamp(estimated, MIN_CU_LIMIT, MAX_CU_LIMIT);
  }

  /**
   * Record the actual CU consumed by a confirmed transaction.
   * Appends to the rolling window (drops oldest when full).
   */
  recordActualCu(type: CuTxType, actualCu: number): void {
    let samples = this.history.get(type);
    if (!samples) {
      samples = [];
      this.history.set(type, samples);
    }

    samples.push(actualCu);

    // Trim to rolling window size
    if (samples.length > WINDOW_SIZE) {
      samples.shift();
    }
  }

  /**
   * Get the number of recorded samples for a given type.
   * Useful for testing and diagnostics.
   */
  sampleCount(type: CuTxType): number {
    return this.history.get(type)?.length ?? 0;
  }

  /**
   * Reset all recorded samples (for testing).
   */
  reset(): void {
    this.history.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared singleton
// ---------------------------------------------------------------------------

/** Global CU estimator instance shared across the application. */
export const cuEstimator = new CUEstimator();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
