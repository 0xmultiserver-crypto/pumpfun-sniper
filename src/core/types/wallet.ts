/**
 * Wallet type definitions.
 *
 * Wallet and account primitives.
 * NO protocol logic. NO business rules. Pure data shapes.
 */

import type { PublicKey } from '@solana/web3.js';

/** Wallet address as base58 string */
export type WalletAddress = string;/** Token account for a specific mint */
export interface TokenAccount {
  readonly address: PublicKey;
  readonly owner: WalletAddress;
  readonly mint: string;
  readonly balance: bigint;
  readonly decimals: number;
}
