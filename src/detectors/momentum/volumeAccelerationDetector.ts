/**
 * Volume Acceleration Detector
 *
 * Detects acceleration in buy volume: compares recent window to previous
 * window. If volume in the recent window is significantly higher, it
 * indicates growing momentum.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { MintAddress } from '../../core/types/token.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('detectors:volumeAcceleration');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Volume acceleration analysis result. */
export interface VolumeAccelerationResult {
  readonly mint: MintAddress;
  /** Volume in the recent (current) window in lamports. */
  readonly recentVolume: bigint;
  /** Volume in the previous (comparison) window in lamports. */
  readonly previousVolume: bigint;
  /** Acceleration ratio: recentVolume / previousVolume. >1 = accelerating. */
  readonly accelerationRatio: number;
  /** Whether the acceleration threshold was met. */
  readonly isAccelerating: boolean;
  /** Buy count in the recent window. */
  readonly recentBuyCount: number;
  /** Buy count in the previous window. */
  readonly previousBuyCount: number;
}

/** A timestamped volume entry. */
export interface VolumeEntry {
  readonly timestamp: number;
  readonly solAmount: bigint;
}

/** Configuration. */
export interface VolumeAccelerationConfig {
  /** Window size in seconds. Recent and previous windows are each this long. Default: 30. */
  readonly windowSeconds?: number;
  /** Minimum acceleration ratio to be considered "accelerating". Default: 2.0. */
  readonly minAccelerationRatio?: number;
  /** Minimum volume in the recent window to trigger (avoids noise). Default: 500_000_000 (0.5 SOL). */
  readonly minRecentVolumeLamports?: bigint;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_MIN_ACCELERATION_RATIO = 2.0;
const DEFAULT_MIN_RECENT_VOLUME = 500_000_000n;

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze volume acceleration for a token.
 *
 * Compares two adjacent time windows:
 *   - Previous window: [now - 2*windowMs, now - windowMs)
 *   - Recent window:   [now - windowMs, now)
 *
 * Pure function — no side effects.
 *
 * @param entries  All volume entries for this token (unsorted is OK).
 * @param mint     Token mint address.
 * @param now      Current timestamp in ms.
 * @param config   Optional configuration overrides.
 */
export function analyzeVolumeAcceleration(
  entries: readonly VolumeEntry[],
  mint: MintAddress,
  now: number,
  config?: VolumeAccelerationConfig,
): VolumeAccelerationResult {
  const windowSeconds = config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const minRatio = config?.minAccelerationRatio ?? DEFAULT_MIN_ACCELERATION_RATIO;
  const minRecentVolume = config?.minRecentVolumeLamports ?? DEFAULT_MIN_RECENT_VOLUME;

  const windowMs = windowSeconds * 1000;
  const recentCutoff = now - windowMs;
  const previousCutoff = now - windowMs * 2;

  let recentVolume = 0n;
  let previousVolume = 0n;
  let recentBuyCount = 0;
  let previousBuyCount = 0;

  for (const entry of entries) {
    if (entry.timestamp >= recentCutoff) {
      recentVolume += entry.solAmount;
      recentBuyCount += 1;
    } else if (entry.timestamp >= previousCutoff) {
      previousVolume += entry.solAmount;
      previousBuyCount += 1;
    }
  }

  // Calculate acceleration ratio
  // If previous volume is 0, any recent volume is "infinite" acceleration
  // We cap at 100.0 for sanity
  let accelerationRatio: number;
  if (previousVolume === 0n) {
    accelerationRatio = recentVolume > 0n ? 100.0 : 0.0;
  } else {
    // Use scaled bigint division for precision, then convert to Number
    const scaled = (recentVolume * 10000n) / previousVolume;
    accelerationRatio = Number(scaled) / 10000;
  }

  const isAccelerating =
    accelerationRatio >= minRatio && recentVolume >= minRecentVolume;

  logger.debug('Volume acceleration analyzed', {
    mint,
    recentVolume: recentVolume.toString(),
    previousVolume: previousVolume.toString(),
    accelerationRatio: accelerationRatio.toFixed(2),
    isAccelerating,
  });

  return {
    mint,
    recentVolume,
    previousVolume,
    accelerationRatio,
    isAccelerating,
    recentBuyCount,
    previousBuyCount,
  };
}
