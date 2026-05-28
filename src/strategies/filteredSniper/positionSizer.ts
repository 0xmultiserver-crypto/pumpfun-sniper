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
 *   4. Market cap tier multiplier: bigger market cap → bigger position
 *   5. Final = base * volumeMult * creatorMult * timingMult * mcapMult, clamped to [min, max]
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
  /** Market cap in USD (null if unavailable). */
  readonly marketCapUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Market Cap Tiers (from ponyin.id)
// ---------------------------------------------------------------------------

export type MarketCapTier = 'MICRO' | 'SMALL' | 'MID' | 'LARGE';

/**
 * Determine market cap tier.
 * - MICRO: <$100K (high risk, snipe only)
 * - SMALL: $100K-$1M (momentum play)
 * - MID: $1M-$10M (swing trade)
 * - LARGE: >$10M (established, CEX play)
 */
function getMarketCapTier(marketCapUsd: number | null | undefined): MarketCapTier {
  if (marketCapUsd === null || marketCapUsd === undefined) return 'MICRO'; // default to conservative
  if (marketCapUsd < 100_000) return 'MICRO';
  if (marketCapUsd < 1_000_000) return 'SMALL';
  if (marketCapUsd < 10_000_000) return 'MID';
  return 'LARGE';
}

/**
 * Market cap tier multiplier for position sizing.
 * Bigger market cap = more liquidity = can handle bigger positions.
 */
function marketCapMultiplier(tier: MarketCapTier): number {
  switch (tier) {
    case 'MICRO': return 0.5;   // High risk, small position
    case 'SMALL': return 1.0;   // Standard position
    case 'MID':   return 1.3;   // Larger position (more liquidity)
    case 'LARGE': return 1.5;   // Largest position (most liquidity)
  }
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
    const mcapTier = getMarketCapTier(params.marketCapUsd);
    const mcapMult = marketCapMultiplier(mcapTier);

    const raw = BASE_POSITION_SIZE_USD * volMult * crMult * timeMult * mcapMult;

    return Math.max(MIN_POSITION_SIZE_USD, Math.min(MAX_POSITION_SIZE_USD, raw));
  }

  /**
   * Get market cap tier for logging/display.
   */
  getTier(marketCapUsd: number | null | undefined): MarketCapTier {
    return getMarketCapTier(marketCapUsd);
  }
}
