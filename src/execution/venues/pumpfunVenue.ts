/**
 * Pump.fun Execution Venue
 *
 * Wraps the adapter-level trade builder into a venue that the
 * execution layer can use uniformly.
 *
 * CRITICAL: correct PDA derivation and instruction building.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { PublicKey } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import type { SwapDirection } from '../../core/types/execution.js';
import {
  deriveBondingCurvePDA,
  deriveAssociatedBondingCurve,
  buildBuyInstruction,
  buildSellInstruction,
} from '../../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:pumpfunVenue');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for building a Pump.fun swap instruction. */
export interface PumpfunSwapParams {
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly direction: SwapDirection;
  /** For BUY: token amount expected. For SELL: token amount to sell. */
  readonly tokenAmount: bigint;
  /** For BUY: max SOL cost (slippage-adjusted). For SELL: min SOL output. */
  readonly slippageAmount: bigint;
  /** Token program that owns this mint (classic Tokenkeg or Token-2022). */
  readonly tokenProgram: PublicKey;
  /** Creator stored in the Pump.fun bonding curve account. Required by current IDL. */
  readonly creator: PublicKey;
  /** Fee recipient selected by current official Pump.fun rules. */
  readonly feeRecipient?: PublicKey;
  /** Buyback fee recipient selected by current official Pump.fun rules. */
  readonly buybackFeeRecipient?: PublicKey;
}

/** Result of building a Pump.fun swap instruction. */
export interface PumpfunSwapResult {
  readonly instruction: TransactionInstruction;
  readonly bondingCurve: PublicKey;
  readonly associatedBondingCurve: PublicKey;
}

// ---------------------------------------------------------------------------
// PumpfunVenue
// ---------------------------------------------------------------------------

export class PumpfunVenue {
  /**
   * Build a swap instruction for Pump.fun.
   *
   * Derives PDAs automatically from the mint.
   */
  buildSwap(params: PumpfunSwapParams): PumpfunSwapResult {
    const bondingCurve = deriveBondingCurvePDA(params.mint);
    const associatedBondingCurve = deriveAssociatedBondingCurve(
      bondingCurve,
      params.mint,
      params.tokenProgram,
    );

    let instruction: TransactionInstruction;

    if (params.direction === 'BUY') {
      instruction = buildBuyInstruction({
        mint: params.mint,
        buyer: params.user,
        bondingCurve,
        associatedBondingCurve,
        tokenAmount: params.tokenAmount,
        maxSolCost: params.slippageAmount,
        tokenProgram: params.tokenProgram,
        creator: params.creator,
        feeRecipient: params.feeRecipient,
        buybackFeeRecipient: params.buybackFeeRecipient,
      });

      logger.debug('Pump.fun BUY instruction built', {
        mint: params.mint.toBase58(),
        tokenAmount: params.tokenAmount.toString(),
        maxSolCost: params.slippageAmount.toString(),
      });
    } else {
      instruction = buildSellInstruction({
        mint: params.mint,
        seller: params.user,
        bondingCurve,
        associatedBondingCurve,
        tokenAmount: params.tokenAmount,
        minSolOutput: params.slippageAmount,
        tokenProgram: params.tokenProgram,
        creator: params.creator,
        feeRecipient: params.feeRecipient,
        buybackFeeRecipient: params.buybackFeeRecipient,
      });

      logger.debug('Pump.fun SELL instruction built', {
        mint: params.mint.toBase58(),
        tokenAmount: params.tokenAmount.toString(),
        minSolOutput: params.slippageAmount.toString(),
      });
    }

    return {
      instruction,
      bondingCurve,
      associatedBondingCurve,
    };
  }
}
