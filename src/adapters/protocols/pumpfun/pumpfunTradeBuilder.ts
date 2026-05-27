/**
 * Pump.fun Trade Builder
 *
 * Builds Pump.fun swap transaction instructions (BUY and SELL).
 * Also provides PDA derivation utilities for bonding curve and ATA accounts.
 *
 * HIGHEST CRITICALITY — instruction layouts, discriminators, account ordering,
 * and PDA seeds are verified from the current public Pump.fun IDL and recent
 * successful mainnet transactions.
 *
 * Adapters = protocol integration ONLY. No strategy logic.
 */

import {
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_GLOBAL_STATE,
  PUMPFUN_EVENT_AUTHORITY,
  PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR,
  PUMPFUN_FEE_CONFIG,
  PUMPFUN_FEE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '../../../core/constants/programs.js';

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the Pump.fun bonding curve PDA for a given mint.
 *
 * Seeds: ["bonding-curve", mint_pubkey]
 * Program: PUMPFUN_PROGRAM_ID
 */
export { deriveBondingCurvePDA } from './shared.js';

/**
 * Derive the Associated Token Account for the bonding curve.
 */
export function deriveAssociatedBondingCurve(
  bondingCurve: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** Derive the buyer/seller's Associated Token Account for a mint. */
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

/** Derive the current Pump.fun creator-vault PDA for a bonding-curve creator. */
export function deriveCreatorVaultPDA(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

/** Derive the current Pump.fun global volume accumulator PDA. */
export function deriveGlobalVolumeAccumulatorPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

/** Derive the current Pump.fun user volume accumulator PDA. */
export function deriveUserVolumeAccumulatorPDA(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

/** Derive the current Pump.fun bonding-curve-v2 PDA used as an official remaining account. */
export function deriveBondingCurveV2PDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

/** Current official static fee recipients from @pump-fun/pump-sdk v1.36.0. */
export const PUMPFUN_FEE_RECIPIENTS = [
  new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV'),
  new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ'),
  new PublicKey('7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX'),
  new PublicKey('9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz'),
  new PublicKey('AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY'),
  new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  new PublicKey('FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz'),
  new PublicKey('G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP'),
] as const;

/** Current official static buyback recipients from @pump-fun/pump-sdk v1.36.0. */
export const PUMPFUN_BUYBACK_FEE_RECIPIENTS = [
  new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
  new PublicKey('9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7'),
  new PublicKey('GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL'),
  new PublicKey('3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR'),
  new PublicKey('5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6'),
  new PublicKey('EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL'),
  new PublicKey('5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD'),
  new PublicKey('A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'),
] as const;

export function getStaticPumpfunFeeRecipient(): PublicKey {
  return PUMPFUN_FEE_RECIPIENTS[Math.floor(Math.random() * PUMPFUN_FEE_RECIPIENTS.length)]!;
}

export function getStaticPumpfunBuybackFeeRecipient(): PublicKey {
  return PUMPFUN_BUYBACK_FEE_RECIPIENTS[
    Math.floor(Math.random() * PUMPFUN_BUYBACK_FEE_RECIPIENTS.length)
  ]!;
}

// ---------------------------------------------------------------------------
// Instruction Data Helpers
// ---------------------------------------------------------------------------

/** Encode a u64 as a little-endian Buffer (8 bytes). */
function encodeU64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

// ---------------------------------------------------------------------------
// Buy Instruction
// ---------------------------------------------------------------------------

/** Pump.fun 'buy' instruction discriminator: SHA256("global:buy")[0..8]. */
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

export interface BuildBuyParams {
  readonly mint: PublicKey;
  readonly buyer: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly associatedBondingCurve: PublicKey;
  /** Token amount expected. */
  readonly tokenAmount: bigint;
  /** Maximum SOL cost the buyer is willing to pay (slippage protection). */
  readonly maxSolCost: bigint;
  /** Token program that owns the mint (Tokenkeg or Token-2022). */
  readonly tokenProgram?: PublicKey;
  /** Creator stored in the bonding curve account at offset 49. */
  readonly creator: PublicKey;
  /** Fee recipient selected by the current official SDK/global rules. */
  readonly feeRecipient?: PublicKey;
  /** Buyback fee recipient selected by the current official SDK rules. */
  readonly buybackFeeRecipient?: PublicKey;
}

/**
 * Build a Pump.fun BUY instruction.
 *
 * Current public IDL account ordering:
 *   0.  global
 *   1.  fee_recipient                 (writable)
 *   2.  mint
 *   3.  bonding_curve                 (writable)
 *   4.  associated_bonding_curve      (writable)
 *   5.  associated_user               (writable)
 *   6.  user                          (writable, signer)
 *   7.  system_program
 *   8.  token_program
 *   9.  creator_vault                 (writable)
 *   10. event_authority
 *   11. program
 *   12. global_volume_accumulator
 *   13. user_volume_accumulator       (writable)
 *   14. fee_config
 *   15. fee_program
 *   16. bonding_curve_v2             (remaining account)
 *   17. buyback_fee_recipient        (remaining account, writable)
 *
 * Data layout:
 *   8 bytes: discriminator
 *   8 bytes: amount (u64 LE)
 *   8 bytes: max_sol_cost (u64 LE)
 *   1 byte : track_volume OptionBool (true)
 */
export function buildBuyInstruction(params: BuildBuyParams): TransactionInstruction {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const buyerATA = deriveUserATA(params.buyer, params.mint, tokenProgram);
  const feeRecipient = params.feeRecipient ?? getStaticPumpfunFeeRecipient();
  const buybackFeeRecipient = params.buybackFeeRecipient ?? getStaticPumpfunBuybackFeeRecipient();

  const data = Buffer.concat([
    BUY_DISCRIMINATOR,
    encodeU64LE(params.tokenAmount),
    encodeU64LE(params.maxSolCost),
    Buffer.from([1]),
  ]);

  const keys = [
    { pubkey: PUMPFUN_GLOBAL_STATE, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
    { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: buyerATA, isSigner: false, isWritable: true },
    { pubkey: params.buyer, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: deriveCreatorVaultPDA(params.creator), isSigner: false, isWritable: true },
    { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
    { pubkey: deriveUserVolumeAccumulatorPDA(params.buyer), isSigner: false, isWritable: true },
    { pubkey: PUMPFUN_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: deriveBondingCurveV2PDA(params.mint), isSigner: false, isWritable: false },
    { pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Sell Instruction
// ---------------------------------------------------------------------------

/** Pump.fun 'sell' instruction discriminator: SHA256("global:sell")[0..8]. */
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

export interface BuildSellParams {
  readonly mint: PublicKey;
  readonly seller: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly associatedBondingCurve: PublicKey;
  /** Number of tokens to sell. */
  readonly tokenAmount: bigint;
  /** Minimum SOL the seller will accept (slippage protection). */
  readonly minSolOutput: bigint;
  /** Token program that owns the mint (Tokenkeg or Token-2022). */
  readonly tokenProgram?: PublicKey;
  /** Creator stored in the bonding curve account at offset 49. */
  readonly creator: PublicKey;
  /** Fee recipient selected by the current official SDK/global rules. */
  readonly feeRecipient?: PublicKey;
  /** Buyback fee recipient selected by the current official SDK rules. */
  readonly buybackFeeRecipient?: PublicKey;
}

/**
 * Build a Pump.fun SELL instruction.
 * Current public IDL account ordering:
 * global, fee_recipient, mint, bonding_curve, associated_bonding_curve,
 * associated_user, user, system_program, creator_vault, token_program,
 * event_authority, program, fee_config, fee_program.
 */
export function buildSellInstruction(params: BuildSellParams): TransactionInstruction {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const sellerATA = deriveUserATA(params.seller, params.mint, tokenProgram);
  const feeRecipient = params.feeRecipient ?? getStaticPumpfunFeeRecipient();
  const buybackFeeRecipient = params.buybackFeeRecipient ?? getStaticPumpfunBuybackFeeRecipient();

  const data = Buffer.concat([
    SELL_DISCRIMINATOR,
    encodeU64LE(params.tokenAmount),
    encodeU64LE(params.minSolOutput),
  ]);

  const keys = [
    { pubkey: PUMPFUN_GLOBAL_STATE, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
    { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: sellerATA, isSigner: false, isWritable: true },
    { pubkey: params.seller, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: deriveCreatorVaultPDA(params.creator), isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: deriveBondingCurveV2PDA(params.mint), isSigner: false, isWritable: false },
    { pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data,
  });
}
