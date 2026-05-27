/**
 * Dynamic Position Sizer
 *
 * Calculates position size in USD based on signal quality.
 * Multipliers are applied to a base size and clamped to [min, max].
 *
 * Algorithm:
 *   1. Volume multiplier: more volume → bigger position (capped at 1.5x)
 *   2. Creator multiplier: higher creator score → bigger position
 *   3. Launch timing multiplier: earlier → bigger position
 *   4. Final = base * volumeMult * creatorMult * timingMult, clamped to [min, max]
 *
 * Falls back to BASE_POSITION_SIZE_USD if any required data is unavailable.
 */

import {
  BASE_POSITION_SIZE_USD,
  MIN_POSITION_SIZE_USD,
  MAX_POSITION_SIZE_USD,
} from './filteredSniperRules.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PositionSizerParams {
  /** Total buy volume in lamports during the momentum window. */
  readonly momentumVolumeLamports: bigint;
  /** Minimum volume threshold (from rules) in lamports. */
  readonly momentumMinVolumeLamports: bigint;
  /** Creator trust score 0-100, or null if unavailable. */
  readonly creatorScore: number | null;
  /** Seconds elapsed since the token was launched. */
  readonly secondsSinceLaunch: number;
}

// ---------------------------------------------------------------------------
// Multipliers
// ---------------------------------------------------------------------------

function volumeMultiplier(
  volumeLamports: bigint,
  minVolumeLamports: bigint,
): number {
  if (minVolumeLamports <= 0n) return 1.0;
  const ratio = Number(volumeLamports) / Number(minVolumeLamports);
  // More volume → larger position, capped at 1.5x
  return Math.min(ratio * 0.5, 1.5);
}

function creatorMultiplier(score: number | null): number {
  if (score === null || score === undefined) return 1.0;
  if (score >= 70) return 1.3;
  if (score >= 40) return 1.0;
  if (score >= 20) return 0.7;
  return 0.5;
}

function timingMultiplier(secondsSinceLaunch: number): number {
  if (secondsSinceLaunch < 30) return 1.2;
  if (secondsSinceLaunch <= 120) return 1.0;
  return 0.8;
}

// ---------------------------------------------------------------------------
// DynamicPositionSizer
// ---------------------------------------------------------------------------

export class DynamicPositionSizer {
  /**
   * Calculate dynamic position size in USD.
   *
   * @returns Position size in USD, clamped to [MIN_POSITION_SIZE_USD, MAX_POSITION_SIZE_USD]
   */
  calculateSize(params: PositionSizerParams): number {
    const volMult = volumeMultiplier(
      params.momentumVolumeLamports,
      params.momentumMinVolumeLamports,
    );
    const crMult = creatorMultiplier(params.creatorScore);
    const timeMult = timingMultiplier(params.secondsSinceLaunch);

    const raw = BASE_POSITION_SIZE_USD * volMult * crMult * timeMult;

    return Math.max(MIN_POSITION_SIZE_USD, Math.min(MAX_POSITION_SIZE_USD, raw));
  }
}
