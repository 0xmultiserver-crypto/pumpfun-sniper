/**
 * Token type definitions.
 *
 * Shared token primitives used across all modules.
 * NO protocol logic. NO business rules. Pure data shapes.
 */

import type { PublicKey } from '@solana/web3.js';

/** Mint address as base58 string */
export type MintAddress = string;

/** Token metadata from on-chain or Pump.fun API */
export interface TokenMetadata {
  readonly mint: MintAddress;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly decimals: number;
}

/** Authority status for a token */
export interface TokenAuthority {
  readonly mint: MintAddress;
  readonly mintAuthority: PublicKey | null;
  readonly freezeAuthority: PublicKey | null;
  readonly mintAuthorityRevoked: boolean;
  readonly freezeAuthorityRevoked: boolean;
}

/** Token supply info — always bigint-safe */
export interface TokenSupply {
  readonly mint: MintAddress;
  readonly totalSupply: bigint;
  readonly decimals: number;
}

/** Pump.fun bonding curve state for a token */
export interface BondingCurveState {
  readonly mint: MintAddress;
  readonly bondingCurveAddress: PublicKey;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly complete: boolean;
}

/** Token launch origin info */
export interface TokenLaunchInfo {
  readonly mint: MintAddress;
  readonly creator: PublicKey;
  readonly createdAt: number;
  readonly slot: number;
  readonly signature: string;
}
