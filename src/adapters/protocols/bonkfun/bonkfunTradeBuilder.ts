/**
 * BonkFun / Raydium LaunchLab Trade Builder
 *
 * Builds swap transaction instructions for BonkFun bonding curve tokens.
 * Uses Raydium LaunchLab's buy_exact_in / sell_exact_in instructions.
 *
 * HIGHEST CRITICALITY — instruction layouts, discriminators, account ordering,
 * and PDA seeds are verified from the Raydium LaunchLab IDL and Chainstack
 * reference implementation.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import {
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  LAUNCHLAB_GLOBAL_CONFIG,
  BONKFUN_PLATFORM_CONFIG,
  WSOL_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '../../../core/constants/programs.js';

import {
  BUY_EXACT_IN_DISCRIMINATOR,
  SELL_EXACT_IN_DISCRIMINATOR,
  derivePoolStatePDA,
  deriveAuthorityPDA,
  deriveEventAuthorityPDA,
  derivePlatformFeeVault,
  deriveCreatorFeeVault,
} from './shared.js';

// ---------------------------------------------------------------------------
// PDA Derivation (re-exports + local)
// ---------------------------------------------------------------------------

export { derivePoolStatePDA } from './shared.js';

/**
 * Derive the user's Associated Token Account for a mint.
 */
export function deriveUserATA(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Derive the pool's base vault ATA.
 * For LaunchLab, the base vault is stored in the pool state account.
 * We can derive it as an ATA of the pool state PDA.
 */
export function derivePoolBaseVault(
  poolState: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [poolState.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Derive the pool's quote vault ATA (WSOL).
 */
export function derivePoolQuoteVault(
  poolState: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [poolState.toBuffer(), tokenProgram.toBuffer(), quoteMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

// ---------------------------------------------------------------------------
// Instruction Builders
// ---------------------------------------------------------------------------

export interface BuildBonkfunBuyParams {
  readonly mint: PublicKey;
  readonly buyer: PublicKey;
  /** SOL amount to spend (in lamports). */
  readonly solAmount: bigint;
  /** Minimum tokens to receive (slippage-adjusted). */
  readonly minTokenOut: bigint;
  /** User's WSOL token account (must already exist with wrapped SOL). */
  readonly userQuoteToken: PublicKey;
  /** User's base token ATA. */
  readonly userBaseToken: PublicKey;
  /** Pool base vault (from pool state). */
  readonly baseVault: PublicKey;
  /** Pool quote vault (from pool state). */
  readonly quoteVault: PublicKey;
  /** Pool creator (from pool state). */
  readonly creator: PublicKey;
}

/**
 * Build a buy_exact_in instruction for Raydium LaunchLab.
 *
 * Accounts (18 total, from IDL + remaining accounts):
 *   #0  payer (signer)
 *   #1  authority PDA
 *   #2  global_config
 *   #3  platform_config (BonkFun)
 *   #4  pool_state (writable)
 *   #5  user_base_token (writable)
 *   #6  user_quote_token (writable)
 *   #7  base_vault (writable)
 *   #8  quote_vault (writable)
 *   #9  base_token_mint
 *   #10 quote_token_mint (WSOL)
 *   #11 base_token_program
 *   #12 quote_token_program
 *   #13 event_authority PDA
 *   #14 program (self-referencing)
 *   #15 system_program (remaining)
 *   #16 platform_fee_vault PDA (remaining, writable)
 *   #17 creator_fee_vault PDA (remaining, writable)
 */
export function buildBuyInstruction(params: BuildBonkfunBuyParams): TransactionInstruction {
  const poolState = derivePoolStatePDA(params.mint);
  const authority = deriveAuthorityPDA();
  const eventAuthority = deriveEventAuthorityPDA();
  const platformFeeVault = derivePlatformFeeVault();
  const creatorFeeVault = deriveCreatorFeeVault(params.creator);

  // Instruction data: discriminator + amount_in (u64) + minimum_amount_out (u64) + share_fee_rate (u64)
  const data = Buffer.alloc(8 + 8 + 8 + 8);
  BUY_EXACT_IN_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(params.solAmount, 8);
  data.writeBigUInt64LE(params.minTokenOut, 16);
  data.writeBigUInt64LE(0n, 24); // share_fee_rate = 0

  const keys = [
    { pubkey: params.buyer, isSigner: true, isWritable: false },           // #0 payer
    { pubkey: authority, isSigner: false, isWritable: false },             // #1 authority
    { pubkey: LAUNCHLAB_GLOBAL_CONFIG, isSigner: false, isWritable: false }, // #2 global_config
    { pubkey: BONKFUN_PLATFORM_CONFIG, isSigner: false, isWritable: false }, // #3 platform_config
    { pubkey: poolState, isSigner: false, isWritable: true },              // #4 pool_state
    { pubkey: params.userBaseToken, isSigner: false, isWritable: true },   // #5 user_base_token
    { pubkey: params.userQuoteToken, isSigner: false, isWritable: true },  // #6 user_quote_token
    { pubkey: params.baseVault, isSigner: false, isWritable: true },       // #7 base_vault
    { pubkey: params.quoteVault, isSigner: false, isWritable: true },      // #8 quote_vault
    { pubkey: params.mint, isSigner: false, isWritable: false },           // #9 base_token_mint
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },            // #10 quote_token_mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // #11 base_token_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // #12 quote_token_program
    { pubkey: eventAuthority, isSigner: false, isWritable: false },        // #13 event_authority
    { pubkey: RAYDIUM_LAUNCHLAB_PROGRAM_ID, isSigner: false, isWritable: false }, // #14 program
    // Remaining accounts
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },     // #15 system_program
    { pubkey: platformFeeVault, isSigner: false, isWritable: true },       // #16 platform_fee_vault
    { pubkey: creatorFeeVault, isSigner: false, isWritable: true },        // #17 creator_fee_vault
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    keys,
    data,
  });
}

export interface BuildBonkfunSellParams {
  readonly mint: PublicKey;
  readonly seller: PublicKey;
  /** Token amount to sell (in base units). */
  readonly tokenAmount: bigint;
  /** Minimum SOL to receive (slippage-adjusted, in lamports). */
  readonly minSolOut: bigint;
  /** User's base token ATA. */
  readonly userBaseToken: PublicKey;
  /** User's WSOL token account (to receive SOL). */
  readonly userQuoteToken: PublicKey;
  /** Pool base vault (from pool state). */
  readonly baseVault: PublicKey;
  /** Pool quote vault (from pool state). */
  readonly quoteVault: PublicKey;
  /** Pool creator (from pool state). */
  readonly creator: PublicKey;
}

/**
 * Build a sell_exact_in instruction for Raydium LaunchLab.
 *
 * Same 18-account structure as buy, but amount_in = token amount.
 */
export function buildSellInstruction(params: BuildBonkfunSellParams): TransactionInstruction {
  const poolState = derivePoolStatePDA(params.mint);
  const authority = deriveAuthorityPDA();
  const eventAuthority = deriveEventAuthorityPDA();
  const platformFeeVault = derivePlatformFeeVault();
  const creatorFeeVault = deriveCreatorFeeVault(params.creator);

  // Instruction data: discriminator + amount_in (u64) + minimum_amount_out (u64) + share_fee_rate (u64)
  const data = Buffer.alloc(8 + 8 + 8 + 8);
  SELL_EXACT_IN_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(params.tokenAmount, 8);
  data.writeBigUInt64LE(params.minSolOut, 16);
  data.writeBigUInt64LE(0n, 24); // share_fee_rate = 0

  const keys = [
    { pubkey: params.seller, isSigner: true, isWritable: false },          // #0 payer
    { pubkey: authority, isSigner: false, isWritable: false },             // #1 authority
    { pubkey: LAUNCHLAB_GLOBAL_CONFIG, isSigner: false, isWritable: false }, // #2 global_config
    { pubkey: BONKFUN_PLATFORM_CONFIG, isSigner: false, isWritable: false }, // #3 platform_config
    { pubkey: poolState, isSigner: false, isWritable: true },              // #4 pool_state
    { pubkey: params.userBaseToken, isSigner: false, isWritable: true },   // #5 user_base_token
    { pubkey: params.userQuoteToken, isSigner: false, isWritable: true },  // #6 user_quote_token
    { pubkey: params.baseVault, isSigner: false, isWritable: true },       // #7 base_vault
    { pubkey: params.quoteVault, isSigner: false, isWritable: true },      // #8 quote_vault
    { pubkey: params.mint, isSigner: false, isWritable: false },           // #9 base_token_mint
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },            // #10 quote_token_mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // #11 base_token_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // #12 quote_token_program
    { pubkey: eventAuthority, isSigner: false, isWritable: false },        // #13 event_authority
    { pubkey: RAYDIUM_LAUNCHLAB_PROGRAM_ID, isSigner: false, isWritable: false }, // #14 program
    // Remaining accounts
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },     // #15 system_program
    { pubkey: platformFeeVault, isSigner: false, isWritable: true },       // #16 platform_fee_vault
    { pubkey: creatorFeeVault, isSigner: false, isWritable: true },        // #17 creator_fee_vault
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Quote Helpers (constant-product AMM formula)
// ---------------------------------------------------------------------------

/**
 * Calculate expected token output for a given SOL input.
 * Uses constant product formula: amount_out = (amount_in * virtual_base) / (virtual_quote + amount_in)
 *
 * @param solAmount - SOL input in lamports
 * @param virtualBase - Virtual token reserves from pool state
 * @param virtualQuote - Virtual SOL reserves from pool state
 * @returns Expected token output in base units
 */
export function calculateBuyQuote(
  solAmount: bigint,
  virtualBase: bigint,
  virtualQuote: bigint,
): bigint {
  if (virtualQuote === 0n) return 0n;
  return (solAmount * virtualBase) / (virtualQuote + solAmount);
}

/**
 * Calculate expected SOL output for a given token input.
 * Uses constant product formula: amount_out = (amount_in * virtual_quote) / (virtual_base + amount_in)
 *
 * @param tokenAmount - Token input in base units
 * @param virtualBase - Virtual token reserves from pool state
 * @param virtualQuote - Virtual SOL reserves from pool state
 * @returns Expected SOL output in lamports
 */
export function calculateSellQuote(
  tokenAmount: bigint,
  virtualBase: bigint,
  virtualQuote: bigint,
): bigint {
  if (virtualBase === 0n) return 0n;
  return (tokenAmount * virtualQuote) / (virtualBase + tokenAmount);
}
