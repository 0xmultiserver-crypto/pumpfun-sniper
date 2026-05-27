/**
 * Signal type definitions.
 *
 * Signals emitted by detectors. Pure data — no decision logic.
 */

import type { MintAddress } from './token.js';
import type { WalletAddress } from './wallet.js';

/** Signal type discriminator */
export type SignalType = 'LAUNCH' | 'MOMENTUM' | 'MIGRATION' | 'LIQUIDITY_PHASE' | 'WASH_TRADE';

/** Unique signal identifier */
export type SignalId = string;

/** Base signal shape — all signals extend this */
export interface BaseSignal {
  readonly id: SignalId;
  readonly type: SignalType;
  readonly mint: MintAddress;
  readonly timestamp: number;
  readonly slot: number;
}

/** New token launch detected */
export interface LaunchSignal extends BaseSignal {
  readonly type: 'LAUNCH';
  readonly creator: WalletAddress;
  readonly signature: string;
}

/** Momentum threshold met */
export interface MomentumSignal extends BaseSignal {
  readonly type: 'MOMENTUM';
  readonly buyCount: number;
  readonly windowSeconds: number;
  readonly volumeSol: bigint;
  /** Number of unique slots with buys in the window (for bundle detection). */
  readonly uniqueSlotCount?: number;
}

/** Token graduated / migrated to Raydium */
export interface MigrationSignal extends BaseSignal {
  readonly type: 'MIGRATION';
  readonly migrationSignature: string;
}

/** Liquidity phase change */
export interface LiquidityPhaseSignal extends BaseSignal {
  readonly type: 'LIQUIDITY_PHASE';
  readonly phase: 'BONDING' | 'GRADUATED';
}

/** Wash trade pattern detected */
export interface WashTradeSignal extends BaseSignal {
  readonly type: 'WASH_TRADE';
  readonly washScore: number;
  readonly washReasons: readonly string[];
}

/** Parsed token launch event (protocol-agnostic). Used by detectors. */
export interface LaunchEvent {
  readonly mint: MintAddress;
  readonly creator: WalletAddress;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly slot: number;
  readonly signature: string;
  readonly timestamp: number;
}

/** Union of all signal types */
export type Signal = LaunchSignal | MomentumSignal | MigrationSignal | LiquidityPhaseSignal | WashTradeSignal;
