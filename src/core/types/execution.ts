/**
 * Execution type definitions.
 *
 * Transaction building, sending, and confirmation types.
 * NO protocol-specific logic. Pure data shapes.
 */
import type { MintAddress } from './token.js';

/** Execution venue discriminator */
export type ExecutionVenue = 'PUMPFUN' | 'JUPITER';

/** Swap direction */
export type SwapDirection = 'BUY' | 'SELL';

/** Swap parameters for execution */
export interface SwapParams {
  readonly mint: MintAddress;
  readonly direction: SwapDirection;
  readonly amountLamports: bigint;
  readonly slippageBps: number;
  readonly venue: ExecutionVenue;
}

/** Transaction send result */
export interface SendResult {
  readonly signature: string;
  readonly sentAt: number;
  readonly slot: number | null;
}

/** Compute budget parameters */
export interface ComputeBudgetParams {
  readonly computeUnitLimit: number;
  readonly computeUnitPrice: bigint;
}

