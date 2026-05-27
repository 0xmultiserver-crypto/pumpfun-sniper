/**
 * Dynamic Compute Unit Estimator
 *
 * Tracks actual compute units consumed per transaction type and provides
 * an adaptive CU limit that converges to real usage + 20% buffer.
 *
 * Design:
 *   - Exponential Moving Average (EMA, alpha=0.3) per TX type
 *   - Falls back to DEFAULT_CU_LIMIT (200,000) until MIN_SAMPLES (5) observed
 *   - After that, uses (EMA * 1.2) clamped to [100_000, 1_400_000]
 *   - Persists estimates to DB (risk_state table) for calibration across restarts
 *   - Thread-safe (no async on hot path, pure in-memory state)
 */

import { createLogger } from '../../telemetry/logging/logger.js';
import { query } from '../../storage/postgres/postgresClient.js';

const logger = createLogger('execution:cuEstimator');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default CU limit when not enough data points exist. */
const DEFAULT_CU_LIMIT = 200_000;

/** Minimum number of data points before using EMA. */
const MIN_SAMPLES = 5;

/** Safety buffer multiplier applied to EMA. */
const BUFFER_MULTIPLIER = 1.2;

/** Exponential moving average smoothing factor (0 < alpha <= 1). */
const EMA_ALPHA = 0.3;

/** Absolute minimum CU limit. */
const MIN_CU_LIMIT = 100_000;

/** Absolute maximum CU limit (Solana runtime cap). */
const MAX_CU_LIMIT = 1_400_000;

/** DB key prefix for CU estimator state persistence. */
const DB_KEY_PREFIX = 'cu_estimator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Transaction type for CU tracking. */
export type CuTxType = 'BUY' | 'SELL';

/** Persisted CU state per transaction type. */
interface CuState {
  readonly ema: number;
  readonly sampleCount: number;
}

/** Full persisted state (both TX types). */
interface PersistedCuState {
  readonly BUY?: CuState;
  readonly SELL?: CuState;
  readonly persistedAt?: number;
}

// ---------------------------------------------------------------------------
// CUEstimator
// ---------------------------------------------------------------------------

export class CUEstimator {
  private readonly state: Map<CuTxType, { ema: number; sampleCount: number }> =
    new Map();

  /**
   * Get the estimated CU limit for a transaction type.
   *
   * - If fewer than MIN_SAMPLES data points: returns DEFAULT_CU_LIMIT.
   * - Otherwise: returns EMA * BUFFER_MULTIPLIER, clamped.
   */
  estimateComputeUnits(type: CuTxType): number {
    const entry = this.state.get(type);
    if (!entry || entry.sampleCount < MIN_SAMPLES) {
      return DEFAULT_CU_LIMIT;
    }

    const estimated = Math.ceil(entry.ema * BUFFER_MULTIPLIER);
    return clamp(estimated, MIN_CU_LIMIT, MAX_CU_LIMIT);
  }

  /**
   * Backward-compatible alias for {@link estimateComputeUnits}.
   */
  estimateCu(type: CuTxType): number {
    return this.estimateComputeUnits(type);
  }

  /**
   * Record the actual CU consumed by a confirmed transaction.
   * Updates the exponential moving average.
   */
  recordActualUsage(type: CuTxType, actualCu: number): void {
    let entry = this.state.get(type);
    if (!entry) {
      entry = { ema: 0, sampleCount: 0 };
      this.state.set(type, entry);
    }

    if (entry.sampleCount === 0) {
      // First sample: initialize EMA to the first value
      entry.ema = actualCu;
    } else {
      // EMA: new = alpha * value + (1 - alpha) * old
      entry.ema = EMA_ALPHA * actualCu + (1 - EMA_ALPHA) * entry.ema;
    }
    entry.sampleCount += 1;

    logger.debug('Recorded CU usage', {
      type,
      actualCu,
      ema: Math.round(entry.ema),
      sampleCount: entry.sampleCount,
      estimate: this.estimateComputeUnits(type),
    });
  }

  /**
   * Backward-compatible alias for {@link recordActualUsage}.
   */
  recordActualCu(type: CuTxType, actualCu: number): void {
    this.recordActualUsage(type, actualCu);
  }

  /**
   * Extract compute units consumed from Solana transaction metadata.
   *
   * The `meta` object comes from `getTransaction()` or `getSignaturesForAddress()`.
   *
   * @param meta  Transaction metadata from RPC.
   * @returns CU consumed, or null if unavailable.
   */
  static getComputeUnitsConsumed(
    meta: { readonly computeUnitsConsumed?: number | bigint } | null | undefined,
  ): number | null {
    if (meta == null) return null;
    const cu = meta.computeUnitsConsumed;
    if (cu === undefined || cu === null) return null;
    return Number(cu);
  }

  /**
   * Get the number of recorded samples for a given type.
   * Useful for testing and diagnostics.
   */
  sampleCount(type: CuTxType): number {
    return this.state.get(type)?.sampleCount ?? 0;
  }

  /**
   * Get the current EMA value for a given type (for diagnostics).
   */
  currentEma(type: CuTxType): number {
    return this.state.get(type)?.ema ?? 0;
  }

  /**
   * Reset all recorded samples (for testing).
   */
  reset(): void {
    this.state.clear();
  }

  // -----------------------------------------------------------------------
  // DB Persistence
  // -----------------------------------------------------------------------

  /**
   * Persist current CU estimates to the database (risk_state table).
   * Survives process restarts.
   */
  async persistToDb(): Promise<void> {
    const state: PersistedCuState = {
      BUY: this.state.get('BUY') ?? undefined,
      SELL: this.state.get('SELL') ?? undefined,
      persistedAt: Date.now(),
    };

    try {
      await query({
        text: `INSERT INTO risk_state (key, value, updated_at)
               VALUES ($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET
                 value      = EXCLUDED.value,
                 updated_at = EXCLUDED.updated_at`,
        values: [DB_KEY_PREFIX, JSON.stringify(state), Date.now()],
      });
      logger.info('CU estimates persisted to DB', {
        buySamples: state.BUY?.sampleCount ?? 0,
        sellSamples: state.SELL?.sampleCount ?? 0,
      });
    } catch (err: unknown) {
      logger.warn('Failed to persist CU estimates to DB', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load CU estimates from the database.
   * Call at startup to restore calibration across restarts.
   */
  async loadFromDb(): Promise<void> {
    try {
      const result = await query<{ value: unknown }>({
        text: 'SELECT value FROM risk_state WHERE key = $1',
        values: [DB_KEY_PREFIX],
      });

      if (result.rows.length === 0) {
        logger.info('No persisted CU estimates found in DB, starting fresh');
        return;
      }

      const row = result.rows[0];
      if (row === undefined) return;

      let parsed: PersistedCuState;
      const val = row.value;
      if (typeof val === 'string') {
        parsed = JSON.parse(val) as PersistedCuState;
      } else {
        parsed = val as PersistedCuState;
      }

      if (parsed.BUY !== undefined) {
        this.state.set('BUY', {
          ema: parsed.BUY.ema,
          sampleCount: parsed.BUY.sampleCount,
        });
      }
      if (parsed.SELL !== undefined) {
        this.state.set('SELL', {
          ema: parsed.SELL.ema,
          sampleCount: parsed.SELL.sampleCount,
        });
      }

      logger.info('CU estimates loaded from DB', {
        buySamples: this.state.get('BUY')?.sampleCount ?? 0,
        buyEma: Math.round(this.state.get('BUY')?.ema ?? 0),
        sellSamples: this.state.get('SELL')?.sampleCount ?? 0,
        sellEma: Math.round(this.state.get('SELL')?.ema ?? 0),
      });
    } catch (err: unknown) {
      logger.warn('Failed to load CU estimates from DB, starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
