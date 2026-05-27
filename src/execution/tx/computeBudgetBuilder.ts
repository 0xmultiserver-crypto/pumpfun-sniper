/**
 * Compute Budget Builder
 *
 * Builds Compute Budget program instructions for setting:
 *   - Compute unit limit (max CU for the tx)
 *   - Compute unit price (priority fee in micro-lamports per CU)
 *
 * CRITICAL: correct instruction layout verified from Solana docs.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import { TransactionInstruction } from '@solana/web3.js';
import { COMPUTE_BUDGET_PROGRAM_ID } from '../../core/constants/programs.js';
import type { ComputeBudgetParams } from '../../core/types/execution.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:computeBudget');

// ---------------------------------------------------------------------------
// Compute Budget instruction discriminators
// ---------------------------------------------------------------------------

/**
 * Instruction 2: SetComputeUnitLimit
 * Data: [2, limit_u32_LE]
 * Source: https://docs.solana.com/developing/programming-model/runtime#compute-budget
 */
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;

/**
 * Instruction 3: SetComputeUnitPrice
 * Data: [3, price_u64_LE]
 * Source: https://docs.solana.com/developing/programming-model/runtime#compute-budget
 */
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a SetComputeUnitLimit instruction.
 *
 * @param units  Max compute units for the transaction (u32, max 1_400_000).
 */
export function buildSetComputeUnitLimitIx(units: number): TransactionInstruction {
  // Validate range
  if (units < 0 || units > 1_400_000) {
    throw new Error(`Compute unit limit out of range: ${units} (max 1,400,000)`);
  }

  const data = Buffer.alloc(5);
  data.writeUInt8(SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR, 0);
  data.writeUInt32LE(units, 1);

  return new TransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Build a SetComputeUnitPrice instruction (priority fee).
 *
 * @param microLamports  Price per compute unit in micro-lamports (u64).
 *                       1 micro-lamport = 0.000001 lamports.
 *                       Example: 50_000 micro-lamports/CU × 200_000 CU = 10_000 lamports = 0.00001 SOL.
 */
export function buildSetComputeUnitPriceIx(microLamports: bigint): TransactionInstruction {
  if (microLamports < 0n) {
    throw new Error(`Compute unit price cannot be negative: ${microLamports}`);
  }

  const data = Buffer.alloc(9);
  data.writeUInt8(SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(microLamports, 1);

  return new TransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Build both compute budget instructions for a transaction.
 *
 * Returns an array of 2 instructions: [SetComputeUnitLimit, SetComputeUnitPrice].
 * Prepend these to your transaction's instruction list.
 */
export function buildComputeBudgetInstructions(
  params: ComputeBudgetParams,
): TransactionInstruction[] {
  logger.debug('Building compute budget instructions', {
    computeUnitLimit: params.computeUnitLimit,
    computeUnitPrice: params.computeUnitPrice.toString(),
  });

  return [
    buildSetComputeUnitLimitIx(params.computeUnitLimit),
    buildSetComputeUnitPriceIx(params.computeUnitPrice),
  ];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export { DEFAULT_PUMPFUN_COMPUTE_BUDGET, DEFAULT_JUPITER_COMPUTE_BUDGET } from '../../core/constants/defaults.js';
