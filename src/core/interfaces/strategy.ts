/**
 * Strategy interface contract.
 *
 * Defines how strategy modules interact with the system.
 * Strategy: business decision logic ONLY.
 * NOT: direct RPC calls, direct DB queries, protocol decoding.
 */

import type { Signal } from '../types/signal.js';

/**
 * Strategy contract — all strategies must implement this.
 *
 * Design: interface matches FilteredSniperStrategy actual API.
 * Entry/exit result types live in strategy implementation
 * (strategy-specific). Core only defines the lifecycle contract.
 */
export interface IStrategy {
  /** Start the strategy (begin monitoring, accept signals). */
  start(): void;

  /** Stop the strategy (cease monitoring). */
  stop(): void;

  /** Handle a detector signal — evaluate entry only for eligible signal types. */
  onSignal(signal: Signal): Promise<unknown>;

  /** Current strategy state. */
  getState(): string;
}
