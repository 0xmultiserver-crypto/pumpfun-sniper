/**
 * Wallet type definitions.
 *
 * Wallet and account primitives.
 * NO protocol logic. NO business rules. Pure data shapes.
 */

import type { PublicKey } from '@solana/web3.js';

/** Wallet address as base58 string */
export type WalletAddress = string;

/** Wallet balance — always bigint-safe */
export interface WalletBalance {
  readonly address: WalletAddress;
  readonly solLamports: bigint;
  readonly lastUpdated: number;
}

/** Token account for a specific mint */
export interface TokenAccount {
  readonly address: PublicKey;
  readonly owner: WalletAddress;
  readonly mint: string;
  readonly balance: bigint;
  readonly decimals: number;
}

/** Wallet concentration info for heuristic checks */
export interface WalletConcentration {
  readonly mint: string;
  readonly topHolders: ReadonlyArray<{
    readonly address: WalletAddress;
    readonly balance: bigint;
    readonly percentOfSupply: number;
  }>;
  readonly totalHolders: number;
  readonly snapshotSlot: number;
}
