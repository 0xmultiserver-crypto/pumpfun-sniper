/**
 * Creator Blacklist (Risk Layer)
 *
 * Runtime-managed blacklist of creator wallets.
 * Automatically adds creators who trigger stop losses.
 * Persists across the session.
 *
 * NOTE: The heuristic-level CreatorBlacklistCheck reads from this blacklist.
 * This module manages the blacklist itself.
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import type { WalletAddress } from '../../core/types/wallet.js';
import type { RiskStateRepository } from '../../storage/repositories/riskStateRepository.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:creatorBlacklist');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Blacklist entry with metadata. */
export interface BlacklistEntry {
  readonly wallet: WalletAddress;
  readonly reason: string;
  readonly addedAt: number;
  readonly autoAdded: boolean;
}

/** Configuration. */
export interface CreatorBlacklistConfig {
  /** Max entries to keep. Default: 10000. */
  readonly maxEntries?: number;
  /** Auto-blacklist creators of tokens that hit stop loss. Default: true. */
  readonly autoBlacklistOnSl?: boolean;
  /** Optional risk state repository for persistence. */
  readonly riskStateRepo?: RiskStateRepository;
}

// ---------------------------------------------------------------------------
// CreatorBlacklist
// ---------------------------------------------------------------------------

export class CreatorBlacklist {
  private readonly entries = new Map<WalletAddress, BlacklistEntry>();
  private readonly maxEntries: number;
  private readonly autoBlacklistOnSl: boolean;
  private readonly riskStateRepo: RiskStateRepository | null;

  private static readonly STATE_KEY = 'creator_blacklist';

  constructor(config?: CreatorBlacklistConfig) {
    this.maxEntries = config?.maxEntries ?? 10_000;
    this.autoBlacklistOnSl = config?.autoBlacklistOnSl ?? true;
    this.riskStateRepo = config?.riskStateRepo ?? null;
  }

  /**
   * Check if a wallet is blacklisted.
   */
  isBlacklisted(wallet: WalletAddress): boolean {
    return this.entries.has(wallet);
  }

  /**
   * Add a wallet to the blacklist.
   */
  add(wallet: WalletAddress, reason: string, autoAdded: boolean): void {
    if (this.entries.has(wallet)) return;

    // Enforce max entries — evict oldest auto-added entries
    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.entries.set(wallet, {
      wallet,
      reason,
      addedAt: nowMs(),
      autoAdded,
    });

    logger.info('Creator blacklisted', { wallet, reason, autoAdded });

    // Persist to DB (fire-and-forget)
    void this.saveToDb();
  }

  /**
   * Remove a wallet from the blacklist.
   */
  remove(wallet: WalletAddress): boolean {
    const existed = this.entries.delete(wallet);
    if (existed) {
      logger.info('Creator removed from blacklist', { wallet });
      // Persist to DB (fire-and-forget)
      void this.saveToDb();
    }
    return existed;
  }

  /**
   * Auto-blacklist a creator after a stop loss (if enabled).
   */
  handleStopLoss(creator: WalletAddress, mint: string): void {
    if (!this.autoBlacklistOnSl) return;
    this.add(creator, `Auto-blacklisted: stop loss on ${mint}`, true);
  }

  /**
   * Get all blacklisted wallets.
   */
  getAll(): readonly BlacklistEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get blacklist size.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Load initial blacklist (e.g., from DB on startup).
   */
  loadBulk(wallets: Iterable<{ wallet: WalletAddress; reason: string }>): void {
    for (const { wallet, reason } of wallets) {
      this.add(wallet, reason, false);
    }
    logger.info('Blacklist bulk loaded', { size: this.entries.size });
  }

  private evictOldest(): void {
    let oldestKey: WalletAddress | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      // Prefer evicting auto-added entries
      if (entry.autoAdded && entry.addedAt < oldestTime) {
        oldestTime = entry.addedAt;
        oldestKey = key;
      }
    }

    // If no auto-added, evict any oldest
    if (oldestKey === null) {
      for (const [key, entry] of this.entries) {
        if (entry.addedAt < oldestTime) {
          oldestTime = entry.addedAt;
          oldestKey = key;
        }
      }
    }

    if (oldestKey !== null) {
      this.entries.delete(oldestKey);
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Restore blacklist from DB. Call once at startup after DB is connected.
   */
  async restore(): Promise<void> {
    if (this.riskStateRepo === null) return;

    try {
      const saved = await this.riskStateRepo.loadState<BlacklistEntry[]>(
        CreatorBlacklist.STATE_KEY,
      );

      if (saved === null || saved.length === 0) {
        logger.info('No saved creator blacklist found — starting fresh');
        return;
      }

      for (const entry of saved) {
        // Use set directly to avoid triggering saveToDb on each entry
        this.entries.set(entry.wallet, entry);
      }

      logger.info('Creator blacklist restored from DB', { size: this.entries.size });
    } catch (err: unknown) {
      logger.warn('Failed to restore creator blacklist — starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private saveToDb(): void {
    if (this.riskStateRepo === null) return;

    const entries = Array.from(this.entries.values());
    void this.riskStateRepo.saveState(CreatorBlacklist.STATE_KEY, entries);
  }
}
