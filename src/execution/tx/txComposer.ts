/**
 * Transaction Composer
 *
 * Composes a complete swap transaction by combining:
 *   - Compute budget instructions (priority fee)
 *   - Swap instruction (from venue)
 *   - ATA creation instruction (if needed)
 *
 * CRITICAL: instruction ordering matters for Solana runtime.
 * Order: [ComputeUnitLimit, ComputeUnitPrice, CreateATA?, Swap]
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { TransactionInstruction } from '@solana/web3.js';
import type { ComputeBudgetParams } from '../../core/types/execution.js';
import { buildComputeBudgetInstructions } from './computeBudgetBuilder.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:txComposer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Instructions to compose into a transaction. */
export interface ComposeParams {
  /** Compute budget params (limit + priority fee). */
  readonly computeBudget: ComputeBudgetParams;
  /** Optional: ATA creation instruction (if buyer doesn't have one yet). */
  readonly createAtaInstruction?: TransactionInstruction;
  /** The main swap instruction (buy/sell). */
  readonly swapInstruction: TransactionInstruction;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * Compose a complete instruction array for a swap transaction.
 *
 * Instruction ordering (CRITICAL — verified):
 *   1. SetComputeUnitLimit
 *   2. SetComputeUnitPrice
 *   3. CreateAssociatedTokenAccount (optional — only if ATA doesn't exist)
 *   4. Swap instruction (buy/sell)
 *
 * Returns the ordered instruction array ready for TxBuilder.build().
 */
export function composeSwapInstructions(params: ComposeParams): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];

  // 1+2. Compute budget
  const budgetIxs = buildComputeBudgetInstructions(params.computeBudget);
  instructions.push(...budgetIxs);

  // 3. Create ATA (if needed)
  if (params.createAtaInstruction !== undefined) {
    instructions.push(params.createAtaInstruction);
    logger.debug('ATA creation instruction included');
  }

  // 4. Swap
  instructions.push(params.swapInstruction);

  logger.debug('Transaction composed', {
    instructionCount: instructions.length,
    hasAtaCreate: params.createAtaInstruction !== undefined,
  });

  return instructions;
}
