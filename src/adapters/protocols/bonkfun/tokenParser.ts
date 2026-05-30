/**
 * BonkFun / Raydium LaunchLab Token Parser
 *
 * Parses pool state account data from on-chain accounts.
 * Structural parsing ONLY — no strategy decisions.
 */

import { PublicKey } from '@solana/web3.js';
import type { MintAddress } from '../../../core/types/token.js';
import { createLogger } from '../../../telemetry/logging/logger.js';
import {
  POOL_STATE_MIN_LEN,
  DISCRIMINATOR_SIZE,
  OFFSET_STATUS,
  OFFSET_VIRTUAL_BASE,
  OFFSET_VIRTUAL_QUOTE,
  OFFSET_REAL_BASE,
  OFFSET_REAL_QUOTE,
  OFFSET_CREATOR,
  OFFSET_BASE_MINT,
  OFFSET_PLATFORM_CONFIG,
  readU64LE,
  readPublicKey,
} from './shared.js';
import { BONKFUN_PLATFORM_CONFIG } from '../../../core/constants/programs.js';

const logger = createLogger('adapters:bonkfun:tokenParser');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedBonkfunPoolState {
  readonly status: number;
  readonly virtualBase: bigint;
  readonly virtualQuote: bigint;
  readonly realBase: bigint;
  readonly realQuote: bigint;
  readonly creator: PublicKey;
  readonly baseMint: PublicKey;
  readonly platformConfig: PublicKey;
  /** Whether the pool has graduated/migrated (status >= some threshold). */
  readonly complete: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse raw pool state account data into a structured object.
 *
 * @param data - Raw account data buffer (including 8-byte discriminator).
 * @param mint - Expected mint address for validation. Optional.
 * @returns Parsed pool state, or null if data is invalid.
 */
export function parsePoolStateData(
  data: Buffer,
  mint?: MintAddress,
): ParsedBonkfunPoolState | null {
  if (data.length < POOL_STATE_MIN_LEN) {
    logger.warn('Pool state data too short', { length: data.length, min: POOL_STATE_MIN_LEN });
    return null;
  }

  try {
    const status: number = data[DISCRIMINATOR_SIZE + OFFSET_STATUS] ?? 0;
    const virtualBase = readU64LE(data, DISCRIMINATOR_SIZE + OFFSET_VIRTUAL_BASE);
    const virtualQuote = readU64LE(data, DISCRIMINATOR_SIZE + OFFSET_VIRTUAL_QUOTE);
    const realBase = readU64LE(data, DISCRIMINATOR_SIZE + OFFSET_REAL_BASE);
    const realQuote = readU64LE(data, DISCRIMINATOR_SIZE + OFFSET_REAL_QUOTE);
    const creator = readPublicKey(data, DISCRIMINATOR_SIZE + OFFSET_CREATOR);
    const baseMint = readPublicKey(data, DISCRIMINATOR_SIZE + OFFSET_BASE_MINT);
    const platformConfig = readPublicKey(data, DISCRIMINATOR_SIZE + OFFSET_PLATFORM_CONFIG);

    // Validate mint if provided
    if (mint && baseMint.toBase58() !== mint) {
      logger.warn('Pool state mint mismatch', {
        expected: mint,
        actual: baseMint.toBase58(),
      });
      return null;
    }

    // Status: 0 = active bonding curve, higher values = graduated/migrated
    // LaunchLab uses status field differently from PumpFun's complete flag
    const complete = status > 0;

    return {
      status,
      virtualBase,
      virtualQuote,
      realBase,
      realQuote,
      creator,
      baseMint,
      platformConfig,
      complete,
    };
  } catch (err: unknown) {
    logger.error('Failed to parse pool state data', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a mint is a BonkFun token by verifying the pool state exists
 * and its platform config matches BonkFun's config.
 */
export function isBonkfunToken(parsed: ParsedBonkfunPoolState): boolean {
  return parsed.platformConfig.equals(BONKFUN_PLATFORM_CONFIG);
}

/**
 * Calculate the price per token in scaled lamports from pool state.
 *
 * Uses 10^6 scaling to match PumpFun's computeBondingCurvePriceScaled(),
 * ensuring PNL calculations cancel out correctly between entry and exit.
 *
 * NOTE: virtualQuote is in 10-lamport units (same as PumpFun virtualSolReserves).
 * The 10^6 scaling handles BigInt precision; the 10-lamport→lamport conversion
 * cancels out when comparing against entry price (which uses actual lamports).
 *
 * @param parsed - Parsed BonkFun pool state
 * @returns Scaled lamports per raw token unit (10^6 scaling)
 */
export function calculatePriceLamports(parsed: ParsedBonkfunPoolState): bigint {
  if (parsed.virtualBase === 0n) return 0n;
  return parsed.virtualQuote * 10n**6n / parsed.virtualBase;
}

/**
 * Calculate market cap in lamports.
 *
 * mcapLamports = pricePerToken * totalSupply
 * With 9 SOL decimals and 6 token decimals, this needs scaling.
 * mcapLamports = (virtualQuote * supply) / virtualBase
 */
export function calculateMcapLamports(
  parsed: ParsedBonkfunPoolState,
  totalSupply: bigint,
): bigint {
  if (parsed.virtualBase === 0n) return 0n;
  return (parsed.virtualQuote * totalSupply) / parsed.virtualBase;
}
