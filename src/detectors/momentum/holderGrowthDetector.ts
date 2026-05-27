/**
 * Holder Growth Detector
 *
 * Tracks unique buyer growth rate for a token.
 * Fast holder growth early in a token's life indicates strong interest.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { WalletAddress } from '../../core/types/wallet.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('detectors:holderGrowth');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Holder growth analysis result. */
export interface HolderGrowthResult {
  readonly mint: MintAddress;
  /** Total unique buyers seen. */
  readonly uniqueBuyers: number;
  /** New unique buyers in the recent window. */
  readonly newBuyersInWindow: number;
  /** Growth rate: new buyers per second in the window. */
  readonly growthRatePerSecond: number;
  /** Whether the growth threshold was met. */
  readonly isGrowing: boolean;
}

/** A single buyer event to feed into the tracker. */
export interface BuyerEvent {
  readonly mint: MintAddress;
  readonly buyer: WalletAddress;
  readonly timestamp: number;
}

/** Configuration. */
export interface HolderGrowthConfig {
  /** Time window in seconds to measure growth. Default: 60. */
  readonly windowSeconds?: number;
  /** Minimum new unique buyers in the window to consider "growing". Default: 3. */
  readonly minNewBuyers?: number;
  /** Max tokens to track simultaneously. Default: 500. */
  readonly maxTrackedTokens?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MIN_NEW_BUYERS = 3;
const DEFAULT_MAX_TRACKED_TOKENS = 500;

// ---------------------------------------------------------------------------
// Internal state per token
// ---------------------------------------------------------------------------

interface TokenHolderState {
  /** All unique buyers ever seen. */
  allBuyers: Set<WalletAddress>;
  /** Recent buyer entries with timestamps for windowed analysis. */
  recentEntries: Array<{ buyer: WalletAddress; timestamp: number; isNew: boolean }>;
}

// ---------------------------------------------------------------------------
// HolderGrowthTracker
// ---------------------------------------------------------------------------

/**
 * Stateful tracker for holder growth across tokens.
 *
 * Usage:
 *   const tracker = new HolderGrowthTracker();
 *   tracker.recordBuyer({ mint, buyer, timestamp });
 *   const result = tracker.analyze(mint);
 */
export class HolderGrowthTracker {
  private readonly tokenStates = new Map<MintAddress, TokenHolderState>();
  private readonly windowMs: number;
  private readonly windowSeconds: number;
  private readonly minNewBuyers: number;
  private readonly maxTrackedTokens: number;

  constructor(config?: HolderGrowthConfig) {
    this.windowSeconds = config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.windowMs = this.windowSeconds * 1000;
    this.minNewBuyers = config?.minNewBuyers ?? DEFAULT_MIN_NEW_BUYERS;
    this.maxTrackedTokens = config?.maxTrackedTokens ?? DEFAULT_MAX_TRACKED_TOKENS;
  }

  /**
   * Record a buyer for a token.
   *
   * Tracks whether this is a *new* unique buyer for this token.
   */
  recordBuyer(event: BuyerEvent): void {
    // Enforce max tracked tokens
    if (!this.tokenStates.has(event.mint) && this.tokenStates.size >= this.maxTrackedTokens) {
      this.evictOldest();
    }

    let state = this.tokenStates.get(event.mint);
    if (state === undefined) {
      state = { allBuyers: new Set(), recentEntries: [] };
      this.tokenStates.set(event.mint, state);
    }

    const isNew = !state.allBuyers.has(event.buyer);
    if (isNew) {
      state.allBuyers.add(event.buyer);
    }

    state.recentEntries.push({
      buyer: event.buyer,
      timestamp: event.timestamp,
      isNew,
    });

    // Trim entries outside the window
    const cutoff = Date.now() - this.windowMs;
    state.recentEntries = state.recentEntries.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * Analyze holder growth for a specific token.
   *
   * Returns null if the token is not being tracked.
   */
  analyze(mint: MintAddress): HolderGrowthResult | null {
    const state = this.tokenStates.get(mint);
    if (state === undefined) return null;

    // Count new unique buyers in the current window
    const cutoff = Date.now() - this.windowMs;
    let newBuyersInWindow = 0;
    for (const entry of state.recentEntries) {
      if (entry.timestamp >= cutoff && entry.isNew) {
        newBuyersInWindow += 1;
      }
    }

    const growthRatePerSecond =
      this.windowSeconds > 0 ? newBuyersInWindow / this.windowSeconds : 0;

    const isGrowing = newBuyersInWindow >= this.minNewBuyers;

    logger.debug('Holder growth analyzed', {
      mint,
      uniqueBuyers: state.allBuyers.size,
      newBuyersInWindow,
      growthRatePerSecond: growthRatePerSecond.toFixed(3),
      isGrowing,
    });

    return {
      mint,
      uniqueBuyers: state.allBuyers.size,
      newBuyersInWindow,
      growthRatePerSecond,
      isGrowing,
    };
  }

  /**
   * Remove tracking state for a token.
   */
  removeToken(mint: MintAddress): void {
    this.tokenStates.delete(mint);
  }

  /**
   * Destroy all state.
   */
  destroy(): void {
    this.tokenStates.clear();
  }

  private evictOldest(): void {
    let oldestMint: MintAddress | null = null;
    let oldestTime = Infinity;

    for (const [mint, state] of this.tokenStates) {
      const lastEntry = state.recentEntries[state.recentEntries.length - 1];
      const ts = lastEntry?.timestamp ?? 0;
      if (ts < oldestTime) {
        oldestTime = ts;
        oldestMint = mint;
      }
    }

    if (oldestMint !== null) {
      this.tokenStates.delete(oldestMint);
    }
  }
}
