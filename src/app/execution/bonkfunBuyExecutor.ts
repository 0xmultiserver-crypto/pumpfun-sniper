/**
 * BonkFun Buy Instruction Builder
 *
 * Builds the complete instruction set for buying BonkFun tokens.
 * Unlike PumpFun (direct SOL transfer), BonkFun requires WSOL wrapping:
 *   1. Create base token ATA (idempotent)
 *   2. Create WSOL account with seed (transfer SOL → wSOL)
 *   3. Initialize WSOL account
 *   4. Execute buy_exact_in (wSOL → tokens)
 *   5. Close WSOL account (unwrap remaining wSOL → native SOL)
 *
 * This is the BonkFun equivalent of the PumpFun buy flow.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { ExecutionRuntime } from './runtime.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { DEFAULT_PUMPFUN_COMPUTE_BUDGET, buildComputeBudgetInstructions } from '../../execution/tx/computeBudgetBuilder.js';
import {
  derivePoolStatePDA,
  deriveUserATA,
  buildBuyInstruction,
  calculateBuyQuote,
} from '../../adapters/protocols/bonkfun/bonkfunTradeBuilder.js';
import { parsePoolStateData } from '../../adapters/protocols/bonkfun/tokenParser.js';
import { SLIPPAGE_BPS } from '../../strategies/filteredSniper/filteredSniperRules.js';
import { MIN_BONKFUN_POOL_STATE_SIZE } from '../../core/constants/programs.js';

const logger = createLogger('app:execution:bonkfunBuy');

export interface BonkfunBuyInstructionsParams {
  readonly runtime: ExecutionRuntime;
  readonly mint: PublicKey;
  readonly user: PublicKey;
  /** SOL amount to spend (in lamports). */
  readonly solAmount: bigint;
  readonly slippageBps?: number;
}

export interface BonkfunBuyInstructionsResult {
  readonly instructions: TransactionInstruction[];
  readonly expectedTokenOut: bigint;
  readonly minTokenOut: bigint;
  readonly creator: PublicKey;
}

/**
 * Build the complete instruction set for a BonkFun buy.
 *
 * Flow: Create ATA → Create WSOL account → Buy → Close WSOL account
 *
 * @returns Instructions array + quote info, or null if pool state invalid.
 */
export async function buildBonkfunBuyInstructions(
  params: BonkfunBuyInstructionsParams,
): Promise<BonkfunBuyInstructionsResult | null> {
  const { runtime, mint, user, solAmount } = params;
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

  // 2. Calculate buy quote
  const expectedTokenOut = calculateBuyQuote(solAmount, parsed.virtualBase, parsed.virtualQuote);
  const minTokenOut = expectedTokenOut * BigInt(10000 - slippageBps) / 10000n;

  // 3. Derive accounts
  const userBaseToken = deriveUserATA(user, mint);

  // Get base vault and quote vault from pool state
  const baseVaultOffset = 8 + 261; // verified on-chain
  const quoteVaultOffset = 8 + 293; // verified on-chain
  const baseVault = new PublicKey(poolAccount.data.subarray(baseVaultOffset, baseVaultOffset + 32));
  const quoteVault = new PublicKey(poolAccount.data.subarray(quoteVaultOffset, quoteVaultOffset + 32));

  // 4. Build WSOL account with seed
  // LaunchLab uses create_account_with_seed to create a temporary WSOL account
  const seed = `bonkfun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wsolAccountWithSeed = await PublicKey.createWithSeed(user, seed, TOKEN_PROGRAM_ID);

  // 5. Build instruction set:
  //    a) Compute budget
  //    b) Create base token ATA (idempotent)
  //    c) Create WSOL account with seed (needs rent + buy amount)
  //    d) Initialize WSOL account (sync native)
  //    e) Buy instruction (wSOL → tokens)
  //    f) Close WSOL account (unwrap remaining wSOL → native SOL)
  const computeBudgetIxs = buildComputeBudgetInstructions(DEFAULT_PUMPFUN_COMPUTE_BUDGET);

  const createBaseAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    userBaseToken,
    user,
    mint,
    TOKEN_PROGRAM_ID,
  );

  // WSOL rent: 1439280 lamports (minimum for token account)
  const WSOL_ACCOUNT_RENT = 1439280n;
  const totalWsolNeeded = solAmount + WSOL_ACCOUNT_RENT;

  const createWsolAccountIx = SystemProgram.createAccountWithSeed({
    fromPubkey: user,
    newAccountPubkey: wsolAccountWithSeed,
    basePubkey: user,
    seed,
    lamports: Number(totalWsolNeeded),
    space: 165, // Token account size
    programId: TOKEN_PROGRAM_ID,
  });

  // Initialize sync native (wraps the SOL in the account)
  const initSyncNativeIx = createSyncNativeInstruction(wsolAccountWithSeed);

  const buyIx = buildBuyInstruction({
    mint,
    buyer: user,
    solAmount,
    minTokenOut,
    userQuoteToken: wsolAccountWithSeed,
    userBaseToken,
    baseVault,
    quoteVault,
    creator: parsed.creator,
  });

  const closeWsolAccountIx = createCloseAccountInstruction(
    wsolAccountWithSeed,
    user,
    user,
    [],
    TOKEN_PROGRAM_ID,
  );

  return {
    instructions: [
      ...computeBudgetIxs,
      createBaseAtaIx,
      createWsolAccountIx,
      initSyncNativeIx,
      buyIx,
      closeWsolAccountIx,
    ],
    expectedTokenOut,
    minTokenOut,
    creator: parsed.creator,
  };
}

/**
 * Create a SyncNative instruction (wraps SOL in a token account).
 * This is the SPL Token SyncNative instruction.
 */
function createSyncNativeInstruction(account: PublicKey): TransactionInstruction {
  // SyncNative instruction data: [17] (instruction index 17 for SyncNative)
  const data = Buffer.from([17]);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data,
  } as any);
}
