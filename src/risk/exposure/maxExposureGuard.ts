/**
 * Max Exposure Guard
 *
 * Prevents opening new positions when max concurrent positions
 * or max total exposure is reached.
 *
 * LOCKED VALUES:
 *   - Max concurrent positions: 1
 *   - Position size: $1
 *   → Max exposure = $1 (1 position × $1)
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { DEFAULT_MAX_CONCURRENT_POSITIONS } from '../../core/constants/defaults.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:maxExposureGuard');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current exposure state. */
export interface ExposureState {
  /** Number of currently open positions. */
  readonly openPositionCount: number;
  /** Total SOL currently at risk (lamports). */
  readonly totalExposureLamports: bigint;
}

/** Exposure check result. */
export interface ExposureCheckResult {
  /** Whether a new position can be opened. */
  readonly allowed: boolean;
  /** Current number of open positions. */
  readonly currentPositions: number;
  /** Max allowed positions. */
  readonly maxPositions: number;
  /** Reason if not allowed. */
  readonly reason: string | null;
}

/** Provider to query current open positions. */
export interface PositionProvider {
  getOpenPositionCount(): Promise<number>;
  getTotalExposureLamports(): Promise<bigint>;
}

/** Configuration. */
export interface MaxExposureGuardConfig {
  /** Max concurrent positions. Default: 1 (LOCKED). */
  readonly maxConcurrentPositions?: number;
}

// ---------------------------------------------------------------------------
// MaxExposureGuard
// ---------------------------------------------------------------------------

export class MaxExposureGuard {
  private readonly maxPositions: number;
  private readonly positionProvider: PositionProvider;

  constructor(positionProvider: PositionProvider, config?: MaxExposureGuardConfig) {
    this.positionProvider = positionProvider;
    this.maxPositions =
      config?.maxConcurrentPositions ?? DEFAULT_MAX_CONCURRENT_POSITIONS;
  }

  /**
   * Check if a new position can be opened.
   */
  async canOpenPosition(): Promise<ExposureCheckResult> {
    const currentCount = await this.positionProvider.getOpenPositionCount();

    if (currentCount >= this.maxPositions) {
      logger.info('Max exposure reached — cannot open new position', {
        currentPositions: currentCount,
        maxPositions: this.maxPositions,
      });
      return {
        allowed: false,
        currentPositions: currentCount,
        maxPositions: this.maxPositions,
        reason: `Max concurrent positions reached: ${currentCount}/${this.maxPositions}`,
      };
    }

    logger.debug('Exposure check passed', {
      currentPositions: currentCount,
      maxPositions: this.maxPositions,
    });
    return {
      allowed: true,
      currentPositions: currentCount,
      maxPositions: this.maxPositions,
      reason: null,
    };
  }

  /**
   * Get current exposure state.
   */
  async getExposure(): Promise<ExposureState> {
    const [count, exposure] = await Promise.all([
      this.positionProvider.getOpenPositionCount(),
      this.positionProvider.getTotalExposureLamports(),
    ]);
    return {
      openPositionCount: count,
      totalExposureLamports: exposure,
    };
  }
}
