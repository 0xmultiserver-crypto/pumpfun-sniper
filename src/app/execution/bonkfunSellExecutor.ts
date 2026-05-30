/**
 * BonkFun Sell Instruction Builder
 *
 * Builds the complete instruction set for selling BonkFun tokens.
 * Unlike PumpFun (direct SOL), BonkFun requires WSOL wrapping:
 *   1. Create WSOL ATA (idempotent)
 *   2. Execute sell_exact_in (tokens → wSOL)
 *   3. Close WSOL ATA (unwrap wSOL → native SOL)
 *
 * This is the BonkFun equivalent of buildPumpfunSellInstructions().
 */

import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import type { ExecutionRuntime } from './runtime.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { TOKEN_PROGRAM_ID, MIN_BONKFUN_POOL_STATE_SIZE } from '../../core/constants/programs.js';
import { DEFAULT_PUMPFUN_COMPUTE_BUDGET, buildComputeBudgetInstructions } from '../../execution/tx/computeBudgetBuilder.js';
import {
  derivePoolStatePDA,
  deriveUserATA,
} from '../../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { parsePoolStateData } from '../../adapters/protocols/bonkfun/tokenParser.js';
import { calculateSellQuote } from '../../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { SLIPPAGE_BPS } from '../../strategies/filteredSniper/filteredSniperRules.js';

const logger = createLogger('app:execution:bonkfunSell');

export interface BonkfunSellInstructionsParams {
  readonly runtime: ExecutionRuntime;
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly tokenAmount: bigint;
  readonly slippageBps?: number;
}

export interface BonkfunSellInstructionsResult {
  readonly instructions: TransactionInstruction[];
  readonly expectedSolOutput: bigint;
  readonly minSolOutput: bigint;
  readonly creator: PublicKey;
}

/**
 * Build the complete instruction set for a BonkFun sell.
 *
 * Flow: Create WSOL ATA → sell_exact_in → Close WSOL ATA
 *
 * @returns Instructions array + quote info, or null if pool state invalid.
 */
export async function buildBonkfunSellInstructions(
  params: BonkfunSellInstructionsParams,
): Promise<BonkfunSellInstructionsResult | null> {
  const { runtime, mint, user, tokenAmount } = params;
  const slippageBps = params.slippageBps ?? SLIPPAGE_BPS;

  // 1. Fetch pool state
  const poolStatePDA = derivePoolStatePDA(mint);
  const poolAccount = await runtime.container.connection.getAccountInfo(poolStatePDA);

  if (!poolAccount?.data || poolAccount.data.length < MIN_BONKFUN_POOL_STATE_SIZE) {
    logger.error('Pool state account not found or too short', {
      mint: mint.toBase58(),
      dataLength: poolAccount?.data?.length ?? 0,
    });
    return null;
  }

  const parsed = parsePoolStateData(Buffer.from(poolAccount.data), mint.toBase58());
  if (!parsed) {
    logger.error('Failed to parse pool state data', { mint: mint.toBase58() });
    return null;
  }

  if (parsed.complete) {
    logger.warn('Pool has graduated — should use Jupiter instead', { mint: mint.toBase58() });
    return null;
  }

  // 2. Calculate sell quote
  const expectedSolOutput = calculateSellQuote(tokenAmount, parsed.virtualBase, parsed.virtualQuote);
  const minSolOutput = expectedSolOutput * BigInt(10000 - slippageBps) / 10000n;

  // 3. Derive accounts
  const userBaseToken = deriveUserATA(user, mint);
  const userQuoteToken = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID);

  // Get base vault and quote vault from pool state parsed data
  const baseVaultOffset = 8 + 261; // verified on-chain
  const quoteVaultOffset = 8 + 293; // verified on-chain
  const baseVault = new PublicKey(poolAccount.data.subarray(baseVaultOffset, baseVaultOffset + 32));
  const quoteVault = new PublicKey(poolAccount.data.subarray(quoteVaultOffset, quoteVaultOffset + 32));

  // 4. Build instruction set:
  //    a) Compute budget
  //    b) Create WSOL ATA (idempotent — no-op if exists)
  //    c) Sell instruction (tokens → wSOL)
  //    d) Close WSOL ATA (unwrap wSOL → native SOL)
  const computeBudgetIxs = buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET);

  const createWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    userQuoteToken,
    user,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  );

  // Import buildSellInstruction from the trade builder
  const { buildSellInstruction } = await import('../../adapters/protocols/bonkfun/bonkfunTradeBuilder.js');

  const sellIx = buildSellInstruction({
    mint,
    seller: user,
    tokenAmount,
    minSolOut: minSolOutput,
    userBaseToken,
    userQuoteToken,
    baseVault,
    quoteVault,
    creator: parsed.creator,
  });

  const closeWsolAtaIx = createCloseAccountInstruction(
    userQuoteToken,
    user,
    user,
    [],
    TOKEN_PROGRAM_ID,
  );

  return {
    instructions: [...computeBudgetIxs, createWsolAtaIx, sellIx, closeWsolAtaIx],
    expectedSolOutput,
    minSolOutput,
    creator: parsed.creator,
  };
}
