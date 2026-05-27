/**
 * Token Blacklist (Risk Layer)
 *
 * Runtime-managed blacklist of token mints.
 * Prevents re-entering tokens that previously caused losses.
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:tokenBlacklist');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token blacklist entry. */
export interface TokenBlacklistEntry {
  readonly mint: MintAddress;
  readonly reason: string;
  readonly addedAt: number;
}

/** Configuration. */
export interface TokenBlacklistConfig {
  /** Max entries. Default: 5000. */
  readonly maxEntries?: number;
}

// ---------------------------------------------------------------------------
// TokenBlacklist
// ---------------------------------------------------------------------------

export class TokenBlacklist {
  private readonly entries = new Map<MintAddress, TokenBlacklistEntry>();
  private readonly maxEntries: number;

  constructor(config?: TokenBlacklistConfig) {
    this.maxEntries = config?.maxEntries ?? 5_000;
  }

  /**
   * Check if a token is blacklisted.
   */
  isBlacklisted(mint: MintAddress): boolean {
    return this.entries.has(mint);
  }

  /**
   * Add a token to the blacklist.
   */
  add(mint: MintAddress, reason: string): void {
    if (this.entries.has(mint)) return;

    if (this.entries.size >= this.maxEntries) {
      // Evict oldest
      let oldestMint: MintAddress | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.addedAt < oldestTime) {
          oldestTime = entry.addedAt;
          oldestMint = key;
        }
      }
      if (oldestMint !== null) {
        this.entries.delete(oldestMint);
      }
    }

    this.entries.set(mint, {
      mint,
      reason,
      addedAt: nowMs(),
    });

    logger.info('Token blacklisted', { mint, reason });
  }

  /**
   * Remove a token from the blacklist.
   */
  remove(mint: MintAddress): boolean {
    const existed = this.entries.delete(mint);
    if (existed) {
      logger.info('Token removed from blacklist', { mint });
    }
    return existed;
  }

  /**
   * Blacklist a token after a stop loss exit.
   */
  handleStopLoss(mint: MintAddress): void {
    this.add(mint, 'Stop loss exit');
  }

  /**
   * Blacklist a token after a failed heuristic check.
   */
  handleFailedCheck(mint: MintAddress, checkName: string): void {
    this.add(mint, `Failed check: ${checkName}`);
  }

  /**
   * Get all blacklisted tokens.
   */
  getAll(): readonly TokenBlacklistEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get blacklist size.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Clear all entries (for testing / reset).
   */
  clear(): void {
    this.entries.clear();
    logger.warn('Token blacklist cleared');
  }
}
