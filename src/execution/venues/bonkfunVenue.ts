/**
 * BonkFun Execution Venue
 *
 * Wraps the adapter-level trade builder into a venue that the
 * execution layer can use uniformly.
 *
 * CRITICAL: BonkFun uses Raydium LaunchLab, which requires WSOL wrapping.
 * Unlike PumpFun (direct SOL transfer), BonkFun trades go through wSOL
 * token accounts — buy sends wSOL, sell receives wSOL.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { PublicKey } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import type { SwapDirection } from '../../core/types/execution.js';
import {
  derivePoolStatePDA,
  deriveUserATA,
  buildBuyInstruction,
  buildSellInstruction,
} from '../../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:bonkfunVenue');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for building a BonkFun swap instruction. */
export interface BonkfunSwapParams {
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly direction: SwapDirection;
  /** For BUY: SOL amount to spend (lamports). For SELL: token amount to sell. */
  readonly amount: bigint;
  /** For BUY: minimum tokens expected. For SELL: minimum SOL output (lamports). */
  readonly minOut: bigint;
  /** User's WSOL token account (must exist with wrapped SOL for buy). */
  readonly userQuoteToken: PublicKey;
  /** Pool state parsed data (needed for vault addresses and creator). */
  readonly poolState: {
    readonly baseVault: PublicKey;
    readonly quoteVault: PublicKey;
    readonly creator: PublicKey;
  };
}

/** Result of building a BonkFun swap instruction. */
export interface BonkfunSwapResult {
  readonly instruction: TransactionInstruction;
  readonly poolStatePDA: PublicKey;
}

// ---------------------------------------------------------------------------
// BonkfunVenue
// ---------------------------------------------------------------------------

export class BonkfunVenue {
  /**
   * Build a swap instruction for BonkFun (Raydium LaunchLab).
   *
   * Derives PDAs automatically from the mint.
   */
  buildSwap(params: BonkfunSwapParams): BonkfunSwapResult {
    const poolStatePDA = derivePoolStatePDA(params.mint);

    let instruction: TransactionInstruction;

    if (params.direction === 'BUY') {
      const userBaseToken = deriveUserATA(params.user, params.mint);

      instruction = buildBuyInstruction({
        mint: params.mint,
        buyer: params.user,
        solAmount: params.amount,
        minTokenOut: params.minOut,
        userQuoteToken: params.userQuoteToken,
        userBaseToken,
        baseVault: params.poolState.baseVault,
        quoteVault: params.poolState.quoteVault,
        creator: params.poolState.creator,
      });

      logger.debug('BonkFun BUY instruction built', {
        mint: params.mint.toBase58(),
        solAmount: params.amount.toString(),
        minTokenOut: params.minOut.toString(),
      });
    } else {
      const userBaseToken = deriveUserATA(params.user, params.mint);

      instruction = buildSellInstruction({
        mint: params.mint,
        seller: params.user,
        tokenAmount: params.amount,
        minSolOut: params.minOut,
        userBaseToken,
        userQuoteToken: params.userQuoteToken,
        baseVault: params.poolState.baseVault,
        quoteVault: params.poolState.quoteVault,
        creator: params.poolState.creator,
      });

      logger.debug('BonkFun SELL instruction built', {
        mint: params.mint.toBase58(),
        tokenAmount: params.amount.toString(),
        minSolOut: params.minOut.toString(),
      });
    }

    return {
      instruction,
      poolStatePDA,
    };
  }
}
