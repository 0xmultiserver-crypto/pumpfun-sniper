/** Helpers for associated token accounts used by transaction assembly. */

import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { deriveUserATA } from '../../adapters/protocols/pumpfun/pumpfunTradeBuilder.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../core/constants/programs.js';

/** Build an idempotent ATA creation ix for the wallet/mint used by swaps. */
export function buildUserAtaCreateInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    deriveUserATA(owner, mint, tokenProgram),
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
