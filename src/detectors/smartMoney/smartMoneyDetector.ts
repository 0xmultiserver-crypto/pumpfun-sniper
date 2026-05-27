/**
 * Smart Money Detector (Phase 4.1)
 *
 * Identifies "smart wallets" by tracking which wallets consistently appear
 * in early top-20 traders on tokens that subsequently pump >5x.
 *
 * Once smart wallets are discovered, the detector monitors new token activity
 * and reports when known smart wallets are buying — providing a momentum
 * boost signal.
 *
 * Auto-discovery:
 *   1. When a token pumps >5x, record its top-20 traders as smart wallets.
 *   2. From profitable wallets, trace other wallets that frequently interact
 *      in the same early trading windows and promote them with a lower score.
 *
 * Data stored entirely in-memory with LRU eviction (max 10,000 wallets).
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import { LRUCache } from '../../core/utils/lruCache.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:smartMoney');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const smartMoneyChecksTotal = new Counter({
  name: 'pumpfun_smartmoney_checks_total',
  help: 'Total smart money checks performed',
  labelNames: ['outcome'] as const,
  registers: [register],
});

const smartMoneyDetectionsTotal = new Counter({
  name: 'pumpfun_smartmoney_detections_total',
  help: 'Total tokens with smart wallet detection above threshold',
  registers: [register],
});

const smartMoneyWalletCount = new Gauge({
  name: 'pumpfun_smartmoney_wallet_count',
  help: 'Number of wallets currently tracked in the smart money database',
  registers: [register],
});

const smartMoneyScoreGauge = new Gauge({
  name: 'pumpfun_smartmoney_score_latest',
  help: 'Smart money score from the most recent check',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of wallets stored in the LRU cache. */
const MAX_SMART_WALLETS = 10_000;

/** Minimum multiple gain to consider a token a "winner" (e.g., 5x = 500%). */
const PUMP_THRESHOLD_MULTIPLIER = 5;

/** Max wallets recorded per winning token (top N traders). */
const TOP_TRADERS_LIMIT = 20;

/** Score assigned when a wallet appears as a top trader on a 5x+ token. */
const DIRECT_SMART_SCORE = 1.0;

/** Score assigned to wallets that co-trade with a known smart wallet. */
const ASSOCIATED_SMART_SCORE = 0.3;

/** Minimum smart money score to trigger a detection event. */
const DETECTION_THRESHOLD = 0.5;

/** Co-occurrence count required to promote an associated wallet. */
const CO_OCCURRENCE_PROMOTE_THRESHOLD = 3;

/** Sliding window for co-occurrence tracking (ms). Defaults to 1 hour. */
const CO_OCCURRENCE_WINDOW_MS = 60 * 60 * 1000;

/** Periodic cleanup interval for stale trade data (ms). */
const CLEANUP_INTERVAL_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the SmartMoneyDetector. */
export interface SmartMoneyDetectorConfig {
  /** Max wallets in LRU cache. Default: 10,000. */
  readonly maxSmartWallets?: number;
  /** Minimum gain multiple to declare a token a winner. Default: 5. */
  readonly pumpThresholdMultiplier?: number;
  /** Max top traders recorded per winner. Default: 20. */
  readonly topTradersLimit?: number;
  /** Score given to wallets found on winners. Default: 1.0. */
  readonly directSmartScore?: number;
  /** Score given to co-trading wallets. Default: 0.3. */
  readonly associatedSmartScore?: number;
  /** Minimum score to count as smart money detection. Default: 0.5. */
  readonly detectionThreshold?: number;
  /** Co-occurrences required for promotion. Default: 3. */
  readonly coOccurrencePromoteThreshold?: number;
}

/** Result returned by checkSmartMoney(). */
export interface SmartMoneyResult {
  /** Number of distinct smart wallets detected buying this token. */
  readonly smartWalletCount: number;
  /** Aggregate smart money confidence score (0-1+). */
  readonly smartMoneyScore: number;
  /** List of detected smart wallet addresses. */
  readonly wallets: ReadonlyArray<string>;
  /** Whether the score exceeds the detection threshold. */
  readonly isDetected: boolean;
}

/** Smart wallet entry in the database. */
interface SmartWalletEntry {
  /** Wallet address. */
  readonly wallet: string;
  /** Current cumulative score. */
  score: number;
  /** Number of winning tokens this wallet appeared on. */
  winningTokenCount: number;
  /** Timestamp when this wallet was last updated. */
  lastUpdatedAt: number;
  /** Set of mints this wallet bought early on that won. */
  winningMints: Set<MintAddress>;
}

/** Trade record for tracking per-token activity. */
interface TokenTradeRecord {
  readonly wallet: string;
  readonly isBuy: boolean;
  readonly timestamp: number;
}

/** Per-token tracking state. */
interface TokenTradeState {
  /** All trades recorded for this token. */
  trades: TokenTradeRecord[];
  /** Last time a smart money check was performed. */
  lastCheckAt: number;
}


// ---------------------------------------------------------------------------
// SmartMoneyDetector
// ---------------------------------------------------------------------------

export class SmartMoneyDetector implements IDetector {
  readonly name = 'smart-money-detector';

  private readonly handlers: SignalHandler[] = [];

  private readonly maxSmartWallets: number;
  private readonly pumpThresholdMultiplier: number;
  private readonly topTradersLimit: number;
  private readonly directSmartScore: number;
  private readonly associatedSmartScore: number;
  private readonly detectionThreshold: number;
  private readonly coOccurrencePromoteThreshold: number;

  /** LRU cache of known smart wallets keyed by wallet address. */
  private readonly smartWallets: LRUCache<string, SmartWalletEntry>;

  /** Per-token trade tracking (for co-occurrence analysis). */
  private readonly tokenTrades = new Map<MintAddress, TokenTradeState>();

  /** Co-occurrence counts: walletA -> { walletB -> count } */
  private readonly coOccurrence = new Map<string, Map<string, number>>();

  private running = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: SmartMoneyDetectorConfig) {
    this.maxSmartWallets = config?.maxSmartWallets ?? MAX_SMART_WALLETS;
    this.pumpThresholdMultiplier = config?.pumpThresholdMultiplier ?? PUMP_THRESHOLD_MULTIPLIER;
    this.topTradersLimit = config?.topTradersLimit ?? TOP_TRADERS_LIMIT;
    this.directSmartScore = config?.directSmartScore ?? DIRECT_SMART_SCORE;
    this.associatedSmartScore = config?.associatedSmartScore ?? ASSOCIATED_SMART_SCORE;
    this.detectionThreshold = config?.detectionThreshold ?? DETECTION_THRESHOLD;
    this.coOccurrencePromoteThreshold =
      config?.coOccurrencePromoteThreshold ?? CO_OCCURRENCE_PROMOTE_THRESHOLD;

    this.smartWallets = new LRUCache<string, SmartWalletEntry>(this.maxSmartWallets);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStaleData();
    }, CLEANUP_INTERVAL_MS);

    logger.info('SmartMoney detector started', {
      maxSmartWallets: this.maxSmartWallets,
      pumpThreshold: this.pumpThresholdMultiplier,
      topTradersLimit: this.topTradersLimit,
      detectionThreshold: this.detectionThreshold,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenTrades.clear();
    this.coOccurrence.clear();
    logger.info('SmartMoney detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API — Trade Recording
  // -----------------------------------------------------------------------

  /**
   * Record a trade event for a given token and wallet.
   * Used to track wallet activity for co-occurrence analysis.
   *
   * @param mint       The token mint address.
   * @param wallet     The trading wallet address.
   * @param isBuy      Whether this is a buy (true) or sell (false).
   * @param timestamp  Trade timestamp in milliseconds.
   */
  recordTrade(mint: MintAddress, wallet: string, isBuy: boolean, timestamp: number): void {
    if (!this.running) return;

    let state = this.tokenTrades.get(mint);
    if (state === undefined) {
      state = { trades: [], lastCheckAt: 0 };
      this.tokenTrades.set(mint, state);
    }

    state.trades.push({ wallet, isBuy, timestamp });

    // Update co-occurrence graph with other wallets buying the same token
    if (isBuy) {
      this.updateCoOccurrence(mint, wallet, timestamp);
    }
  }

  // -----------------------------------------------------------------------
  // Public API — Smart Money Check
  // -----------------------------------------------------------------------

  /**
   * Check whether any known smart wallets have been buying a given token.
   *
   * @param mint  The token mint address to check.
   * @returns     SmartMoneyResult with count, score, and wallet list.
   */
  checkSmartMoney(mint: MintAddress): SmartMoneyResult {
    if (!this.running) {
      logger.warn('checkSmartMoney called while detector is not running', { mint });
      smartMoneyChecksTotal.inc({ outcome: 'not_running' });
      return this.buildDefaultResult();
    }

    smartMoneyChecksTotal.inc({ outcome: 'checked' });

    const state = this.tokenTrades.get(mint);
    if (state === undefined) {
      return this.buildDefaultResult();
    }

    // Collect wallets that are buying this token
    const buyingWallets = new Set<string>();
    for (const trade of state.trades) {
      if (trade.isBuy) {
        buyingWallets.add(trade.wallet);
      }
    }

    // Cross-reference with known smart wallets
    const detectedSmartWallets: Array<{ wallet: string; score: number }> = [];

    for (const wallet of buyingWallets) {
      const entry = this.smartWallets.get(wallet);
      if (entry !== undefined && entry.score > 0) {
        detectedSmartWallets.push({ wallet, score: entry.score });
      }
    }

    // Sort by score descending
    detectedSmartWallets.sort((a, b) => b.score - a.score);

    // Calculate aggregate score — sum of individual scores, capped at 1.5
    let aggregateScore = 0;
    for (const { score } of detectedSmartWallets) {
      aggregateScore += score;
    }
    // Normalize: first wallet contributes full score, diminishing returns
    const smartMoneyScore = Math.min(aggregateScore, 1.5);

    const smartWalletCount = detectedSmartWallets.length;
    const isDetected = smartMoneyScore >= this.detectionThreshold;

    if (isDetected) {
      smartMoneyDetectionsTotal.inc();
      logger.info('Smart money detected', {
        mint: mint.slice(0, 12),
        smartWalletCount,
        smartMoneyScore: smartMoneyScore.toFixed(3),
        topWallets: detectedSmartWallets.slice(0, 5).map((w) => w.wallet.slice(0, 8)),
      });
    }

    smartMoneyScoreGauge.set(smartMoneyScore);

    state.lastCheckAt = nowMs();

    return {
      smartWalletCount,
      smartMoneyScore,
      wallets: detectedSmartWallets.map((w) => w.wallet),
      isDetected,
    };
  }

  // -----------------------------------------------------------------------
  // Public API — Winner Registration (Historical)
  // -----------------------------------------------------------------------

  /**
   * Register a token as a historical winner (pumped >5x).
   * The wallets provided are the top traders on this token.
   * Each wallet is promoted into the smart wallet database.
   *
   * @param mint     The winning token's mint address.
   * @param wallets  Top trader wallet addresses (up to topTradersLimit).
   */
  registerWinner(mint: MintAddress, wallets: ReadonlyArray<string>): void {
    if (!this.running) return;

    const limitedWallets = wallets.slice(0, this.topTradersLimit);

    logger.info('Registering winning token traders', {
      mint: mint.slice(0, 12),
      walletCount: limitedWallets.length,
    });

    for (const wallet of limitedWallets) {
      this.promoteWallet(wallet, mint, this.directSmartScore);
    }

    // Update associated wallets via co-occurrence
    this.discoverAssociatedWallets(limitedWallets, mint);

    smartMoneyWalletCount.set(this.smartWallets.size);
  }

  /**
   * Mark a token as graduated (pumped enough) and auto-register its top
   * buyers as smart wallets.
   *
   * @param mint         The token mint address.
   * @param topBuyers    Top buyer wallets sorted by buy volume.
   * @param gainMultiple Current gain multiple (e.g., 5.0 = 5x).
   */
  onTokenGraduated(
    mint: MintAddress,
    topBuyers: ReadonlyArray<string>,
    gainMultiple: number,
  ): void {
    if (!this.running) return;

    if (gainMultiple >= this.pumpThresholdMultiplier) {
      logger.info('Token exceeded pump threshold — promoting wallets', {
        mint: mint.slice(0, 12),
        gainMultiple: gainMultiple.toFixed(1),
        buyerCount: topBuyers.length,
      });
      this.registerWinner(mint, topBuyers);
    }
  }

  // -----------------------------------------------------------------------
  // Smart wallet database management
  // -----------------------------------------------------------------------

  /**
   * Promote (or update) a wallet in the smart wallet database.
   * If the wallet already exists, its score is boosted with diminishing returns.
   */
  private promoteWallet(wallet: string, mint: MintAddress, scoreIncrement: number): void {
    let entry = this.smartWallets.get(wallet);

    if (entry === undefined) {
      entry = {
        wallet,
        score: 0,
        winningTokenCount: 0,
        lastUpdatedAt: nowMs(),
        winningMints: new Set(),
      };
      this.smartWallets.set(wallet, entry);
    }

    // Only count each mint once per wallet
    if (!entry.winningMints.has(mint)) {
      entry.winningMints.add(mint);
      entry.winningTokenCount += 1;

      // Diminishing returns: each additional win adds less
      const diminishingFactor = 1 / (1 + entry.winningTokenCount * 0.3);
      entry.score = Math.min(entry.score + scoreIncrement * diminishingFactor + scoreIncrement, 2.0);
      entry.lastUpdatedAt = nowMs();
    }
  }

  /**
   * Discover associated wallets from co-occurrence data.
   * If wallet A is smart and wallet B bought the same tokens early,
   * promote wallet B with a lower score.
   */
  private discoverAssociatedWallets(
    smartWallets: ReadonlyArray<string>,
    mint: MintAddress,
  ): void {
    const state = this.tokenTrades.get(mint);
    if (state === undefined) return;

    const earlyBuyers = new Set<string>();
    const cutoff = nowMs() - CO_OCCURRENCE_WINDOW_MS;

    for (const trade of state.trades) {
      if (trade.isBuy && trade.timestamp >= cutoff) {
        earlyBuyers.add(trade.wallet);
      }
    }

    for (const wallet of earlyBuyers) {
      // Skip wallets that are already in the smart set
      if (smartWallets.includes(wallet)) continue;

      // Count how many of the known smart wallets this wallet co-traded with
      let coTradeCount = 0;
      for (const smartWallet of smartWallets) {
        const count = this.getCoOccurrenceCount(wallet, smartWallet);
        if (count >= this.coOccurrencePromoteThreshold) {
          coTradeCount += 1;
        }
      }

      if (coTradeCount >= 1) {
        this.promoteWallet(wallet, mint, this.associatedSmartScore);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Co-occurrence tracking
  // -----------------------------------------------------------------------

  /**
   * Update the co-occurrence graph when a wallet buys a token.
   * Records pairwise interactions between all wallets buying the same token.
   */
  private updateCoOccurrence(mint: MintAddress, wallet: string, _timestamp: number): void {
    const state = this.tokenTrades.get(mint);
    if (state === undefined) return;

    // Find other wallets that bought this token recently
    const otherWallets = new Set<string>();
    for (const trade of state.trades) {
      if (trade.isBuy && trade.wallet !== wallet) {
        otherWallets.add(trade.wallet);
      }
    }

    for (const otherWallet of otherWallets) {
      this.incrementCoOccurrence(wallet, otherWallet);
    }
  }

  private incrementCoOccurrence(walletA: string, walletB: string): void {
    // Ensure consistent ordering to avoid duplicates
    const [key1, key2] = walletA < walletB ? [walletA, walletB] : [walletB, walletA];

    let inner = this.coOccurrence.get(key1);
    if (inner === undefined) {
      inner = new Map();
      this.coOccurrence.set(key1, inner);
    }

    const current = inner.get(key2) ?? 0;
    inner.set(key2, current + 1);
  }

  private getCoOccurrenceCount(walletA: string, walletB: string): number {
    const [key1, key2] = walletA < walletB ? [walletA, walletB] : [walletB, walletA];
    return this.coOccurrence.get(key1)?.get(key2) ?? 0;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private purgeStaleData(): void {
    const now = nowMs();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes of inactivity

    // Purge stale token trade states
    let purgedTokens = 0;
    for (const [mint, state] of this.tokenTrades) {
      if (state.trades.length === 0) {
        this.tokenTrades.delete(mint);
        purgedTokens++;
        continue;
      }

      const lastTrade = state.trades[state.trades.length - 1];
      if (lastTrade !== undefined && now - lastTrade.timestamp > staleThreshold) {
        this.tokenTrades.delete(mint);
        purgedTokens++;
      }
    }

    // Trim co-occurrence map if too large (> 50k entries)
    if (this.coOccurrence.size > 50_000) {
      const entries = [...this.coOccurrence.entries()];
      entries.sort((a, b) => {
        const maxA = Math.max(...a[1].values());
        const maxB = Math.max(...b[1].values());
        return maxA - maxB;
      });

      // Remove bottom 20%
      const removeCount = Math.floor(entries.length * 0.2);
      for (let i = 0; i < removeCount; i++) {
        const entry = entries[i];
        if (entry !== undefined) {
          this.coOccurrence.delete(entry[0]);
        }
      }

      logger.debug('Trimmed co-occurrence map', {
        removed: removeCount,
        remaining: this.coOccurrence.size,
      });
    }

    if (purgedTokens > 0) {
      logger.debug('Purged stale token trade states', { purgedTokens });
    }

    smartMoneyWalletCount.set(this.smartWallets.size);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildDefaultResult(): SmartMoneyResult {
    return {
      smartWalletCount: 0,
      smartMoneyScore: 0,
      wallets: [],
      isDetected: false,
    };
  }

  // -----------------------------------------------------------------------
  // Introspection (for testing / debugging)
  // -----------------------------------------------------------------------

  /** Get the number of tracked smart wallets. */
  getSmartWalletCount(): number {
    return this.smartWallets.size;
  }

  /** Check if a wallet is in the smart database. */
  isSmartWallet(wallet: string): boolean {
    return this.smartWallets.has(wallet);
  }

  /** Get a smart wallet's score, or 0 if unknown. */
  getWalletScore(wallet: string): number {
    return this.smartWallets.get(wallet)?.score ?? 0;
  }

  /** Get the number of tokens currently tracked. */
  getTrackedTokenCount(): number {
    return this.tokenTrades.size;
  }
}
