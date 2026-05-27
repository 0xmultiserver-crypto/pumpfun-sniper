/**
 * Cabal Wallet Cluster Detector (Phase 4.2)
 *
 * Detects coordinated wallet clusters ("cabals") that frequently buy
 * the same tokens together — a common PumpFun manipulation pattern.
 *
 * Detection logic:
 *   1. Track which wallets buy which tokens (with timestamps).
 *   2. Cluster wallets that co-occur in 3+ tokens within a rolling 24h window.
 *   3. For any new token, if 3+ wallets from the same cluster buy it,
 *      flag it as a "cabal play" with a weighted cabal score.
 *
 * Extends the creator-blacklist concept to cabal cluster blacklists:
 *   - Clusters with repeated cabal plays are auto-blacklisted.
 *   - Blacklisted clusters add negative signal weight.
 *
 * Design:
 *   - Pure detector layer — no execution, no risk decisions.
 *   - LRU-bounded caches (max 5 000 cluster entries).
 *   - Prometheus metrics for observability.
 */

import { Counter, Registry } from 'prom-client';
import { LRUCache } from '../../core/utils/lruCache.js';
import type { MintAddress } from '../../core/types/token.js';
import type { WalletAddress } from '../../core/types/wallet.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { UnionFind } from '../../core/utils/unionFind.js';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:cabal');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window for co-occurrence analysis (24h in ms). */
const CO_OCCURRENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimum shared tokens for two wallets to be considered clustered. */
const MIN_SHARED_TOKENS = 3;

/** Minimum wallets from a cluster buying the same token to flag as cabal. */
const MIN_CABAL_WALLETS = 3;

/** Cleanup interval — purge stale data every 5 minutes. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum number of wallet clusters to keep in the LRU cache. */
const MAX_CLUSTER_CACHE_SIZE = 5_000;

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const cabalChecksTotal = new Counter({
  name: 'pumpfun_cabal_checks_total',
  help: 'Total cabal analysis checks performed',
  registers: [register as Registry],
});

const cabalDetectionsTotal = new Counter({
  name: 'pumpfun_cabal_detections_total',
  help: 'Total cabal play detections',
  registers: [register as Registry],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the cabal detector. */
export interface CabalDetectorConfig {
  /** Rolling co-occurrence window in ms. Default: 24h. */
  readonly coOccurrenceWindowMs?: number;
  /** Minimum shared tokens for clustering. Default: 3. */
  readonly minSharedTokens?: number;
  /** Minimum cluster wallets on one token to flag cabal. Default: 3. */
  readonly minCabalWallets?: number;
  /** Max cluster cache entries (LRU). Default: 5000. */
  readonly maxClusterCacheSize?: number;
}

/** A single recorded trade for cabal tracking. */
export interface CabalTradeRecord {
  readonly mint: MintAddress;
  readonly wallet: WalletAddress;
  readonly timestamp: number;
}

/** Result of cabal analysis for a token. */
export interface CabalAnalysisResult {
  /** Aggregate cabal score (0–100). Higher = stronger cabal signal. */
  readonly cabalScore: number;
  /** Number of wallets in the detected cluster. */
  readonly clusterSize: number;
  /** Wallet addresses involved in the cabal activity. */
  readonly wallets: readonly WalletAddress[];
  /** Whether this token is flagged as a cabal play. */
  readonly isCabal: boolean;
  /** Cluster IDs involved (for blacklist lookups). */
  readonly clusterIds: readonly string[];
}

/** Internal cluster representation. */
interface WalletCluster {
  readonly id: string;
  readonly wallets: Set<WalletAddress>;
  readonly createdAt: number;
  lastSeenAt: number;
  /** How many times this cluster triggered a cabal detection. */
  cabalHitCount: number;
}




// ---------------------------------------------------------------------------
// CabalDetector
// ---------------------------------------------------------------------------

export class CabalDetector implements IDetector {
  readonly name = 'cabal-detector';

  private readonly handlers: SignalHandler[] = [];

  private readonly coOccurrenceWindowMs: number;
  private readonly minSharedTokens: number;
  private readonly minCabalWallets: number;

  private running = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Token → wallet → timestamp of most recent buy.
   * Used for co-occurrence analysis within the rolling window.
   */
  private readonly tokenWallets = new Map<MintAddress, Map<WalletAddress, number>>();

  /**
   * Wallet → set of tokens bought (within the window).
   */
  private readonly walletTokens = new Map<WalletAddress, Set<MintAddress>>();

  /**
   * LRU cache of identified wallet clusters.
   * Keyed by cluster ID (deterministic sorted wallet list hash).
   */
  private readonly clusterCache: LRUCache<string, WalletCluster>;

  /**
   * Blacklisted cluster IDs — auto-blacklisted after repeated cabal hits.
   */
  private readonly blacklistedClusters = new Set<string>();

  constructor(config?: CabalDetectorConfig) {
    this.coOccurrenceWindowMs = config?.coOccurrenceWindowMs ?? CO_OCCURRENCE_WINDOW_MS;
    this.minSharedTokens = config?.minSharedTokens ?? MIN_SHARED_TOKENS;
    this.minCabalWallets = config?.minCabalWallets ?? MIN_CABAL_WALLETS;
    this.clusterCache = new LRUCache(config?.maxClusterCacheSize ?? MAX_CLUSTER_CACHE_SIZE);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStale();
    }, CLEANUP_INTERVAL_MS);

    logger.info('Cabal detector started', {
      coOccurrenceWindowMs: this.coOccurrenceWindowMs,
      minSharedTokens: this.minSharedTokens,
      minCabalWallets: this.minCabalWallets,
      maxClusterCacheSize: this.clusterCache.size,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenWallets.clear();
    this.walletTokens.clear();
    this.clusterCache.clear();
    this.blacklistedClusters.clear();

    logger.info('Cabal detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Trade recording
  // -------------------------------------------------------------------------

  /**
   * Record a trade (buy) event for cabal co-occurrence tracking.
   *
   * @param mint      Token mint address.
   * @param wallet    Buyer wallet address.
   * @param timestamp Trade timestamp in ms.
   */
  recordTrade(mint: MintAddress, wallet: WalletAddress, timestamp: number): void {
    if (!this.running) return;

    // Update token → wallets map
    let wallets = this.tokenWallets.get(mint);
    if (wallets === undefined) {
      wallets = new Map();
      this.tokenWallets.set(mint, wallets);
    }
    wallets.set(wallet, timestamp);

    // Update wallet → tokens map
    let tokens = this.walletTokens.get(wallet);
    if (tokens === undefined) {
      tokens = new Set();
      this.walletTokens.set(wallet, tokens);
    }
    tokens.add(mint);
  }

  // -------------------------------------------------------------------------
  // Cabal analysis
  // -------------------------------------------------------------------------

  /**
   * Analyse whether a given token is a cabal play.
   *
   * Steps:
   *   1. Get all wallets that bought this token.
   *   2. Build clusters from wallet co-occurrence data.
   *   3. Check if any cluster has >= minCabalWallets buying this token.
   *   4. Compute a weighted cabal score.
   *
   * @param mint Token mint address to analyse.
   * @returns    Cabal analysis result.
   */
  analyzeCabal(mint: MintAddress): CabalAnalysisResult {
    cabalChecksTotal.inc();

    const walletsOnToken = this.tokenWallets.get(mint);
    if (walletsOnToken === undefined || walletsOnToken.size === 0) {
      return this.emptyResult();
    }

    const now = nowMs();
    const cutoff = now - this.coOccurrenceWindowMs;

    // Filter to wallets active within the window
    const activeWallets: WalletAddress[] = [];
    for (const [wallet, ts] of walletsOnToken) {
      if (ts >= cutoff) {
        activeWallets.push(wallet);
      }
    }

    if (activeWallets.length < this.minCabalWallets) {
      return this.emptyResult();
    }

    // Build clusters from active wallets' co-occurrence patterns
    const clusters = this.buildClusters(activeWallets, now);

    // Find the cluster (if any) with the most wallets on this token
    let bestCluster: WalletCluster | null = null;
    let bestOverlap = 0;

    for (const cluster of clusters) {
      let overlap = 0;
      for (const wallet of activeWallets) {
        if (cluster.wallets.has(wallet)) {
          overlap++;
        }
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCluster = cluster;
      }
    }

    const isCabal = bestCluster !== null && bestOverlap >= this.minCabalWallets;

    if (isCabal && bestCluster !== null) {
      bestCluster.cabalHitCount++;
      bestCluster.lastSeenAt = now;

      // Auto-blacklist clusters with repeated cabal hits (>= 3)
      if (bestCluster.cabalHitCount >= 3 && !this.blacklistedClusters.has(bestCluster.id)) {
        this.blacklistedClusters.add(bestCluster.id);
        logger.warn('Cabal cluster auto-blacklisted', {
          clusterId: bestCluster.id,
          clusterSize: bestCluster.wallets.size,
          hitCount: bestCluster.cabalHitCount,
        });
      }

      cabalDetectionsTotal.inc();

      const cabalWallets = activeWallets.filter((w) => bestCluster!.wallets.has(w));

      logger.warn('Cabal play detected', {
        mint: mint.slice(0, 12),
        clusterId: bestCluster.id,
        clusterSize: bestCluster.wallets.size,
        overlapWallets: cabalWallets.length,
        cabalHitCount: bestCluster.cabalHitCount,
      });

      return {
        cabalScore: this.computeScore(bestCluster, bestOverlap),
        clusterSize: bestCluster.wallets.size,
        wallets: cabalWallets,
        isCabal: true,
        clusterIds: [bestCluster.id],
      };
    }

    // No cabal detected — but return partial info if clusters exist
    const allClusterIds: string[] = [];
    for (const c of clusters) {
      allClusterIds.push(c.id);
    }

    return {
      cabalScore: 0,
      clusterSize: bestCluster?.wallets.size ?? 0,
      wallets: activeWallets.filter((w) => bestCluster?.wallets.has(w) ?? false),
      isCabal: false,
      clusterIds: allClusterIds,
    };
  }

  /**
   * Check if a cluster ID is blacklisted.
   */
  isClusterBlacklisted(clusterId: string): boolean {
    return this.blacklistedClusters.has(clusterId);
  }

  /**
   * Manually blacklist a cluster.
   */
  blacklistCluster(clusterId: string, reason: string): void {
    this.blacklistedClusters.add(clusterId);
    logger.info('Cluster manually blacklisted', { clusterId, reason });
  }

  /**
   * Get the current number of tracked clusters.
   */
  get clusterCount(): number {
    return this.clusterCache.size;
  }

  /**
   * Get the number of blacklisted clusters.
   */
  get blacklistedClusterCount(): number {
    return this.blacklistedClusters.size;
  }

  // -------------------------------------------------------------------------
  // Cluster building (Union-Find based)
  // -------------------------------------------------------------------------

  /**
   * Build wallet clusters from co-occurrence data.
   * Two wallets are linked if they share >= minSharedTokens in the window.
   * Overlapping links are merged via Union-Find.
   */
  private buildClusters(
    candidateWallets: readonly WalletAddress[],
    now: number,
  ): WalletCluster[] {
    const cutoff = now - this.coOccurrenceWindowMs;
    const uf = new UnionFind();

    // For each candidate wallet, find other wallets that share tokens
    for (const wallet of candidateWallets) {
      const tokens = this.walletTokens.get(wallet);
      if (tokens === undefined) continue;

      // Count co-occurrence with other wallets
      const coOccurrence = new Map<WalletAddress, number>();

      for (const mint of tokens) {
        const walletsOnToken = this.tokenWallets.get(mint);
        if (walletsOnToken === undefined) continue;

        for (const [otherWallet, ts] of walletsOnToken) {
          if (otherWallet === wallet || ts < cutoff) continue;
          coOccurrence.set(otherWallet, (coOccurrence.get(otherWallet) ?? 0) + 1);
        }
      }

      // Link wallets with sufficient co-occurrence
      for (const [otherWallet, count] of coOccurrence) {
        if (count >= this.minSharedTokens) {
          uf.union(wallet, otherWallet);
        }
      }
    }

    // Group wallets by root
    const groups = new Map<string, Set<WalletAddress>>();
    for (const wallet of candidateWallets) {
      const root = uf.find(wallet);
      let group = groups.get(root);
      if (group === undefined) {
        group = new Set();
        groups.set(root, group);
      }
      group.add(wallet);
    }

    // Build or retrieve cached cluster objects
    const clusters: WalletCluster[] = [];

    for (const [_root, wallets] of groups) {
      if (wallets.size < 2) continue; // Need at least 2 for a cluster

      const clusterId = this.computeClusterId(wallets);

      // Check cache first
      let cluster = this.clusterCache.get(clusterId);
      if (cluster !== undefined) {
        // Update last seen
        cluster.lastSeenAt = now;
        clusters.push(cluster);
      } else {
        // Create new cluster
        cluster = {
          id: clusterId,
          wallets,
          createdAt: now,
          lastSeenAt: now,
          cabalHitCount: 0,
        };
        this.clusterCache.set(clusterId, cluster);
        clusters.push(cluster);

        logger.debug('New wallet cluster identified', {
          clusterId,
          size: wallets.size,
        });
      }
    }

    return clusters;
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  /**
   * Compute a cabal score (0–100) based on cluster properties.
   *
   * Factors:
   *   - Overlap ratio: how many cluster wallets are on this token (40%)
   *   - Cluster size: larger clusters = higher score (30%)
   *   - Historical cabal hits: repeated offenders score higher (20%)
   *   - Blacklist bonus: blacklisted clusters get extra weight (10%)
   */
  private computeScore(cluster: WalletCluster, overlapCount: number): number {
    const clusterSize = cluster.wallets.size;

    // Overlap ratio (0–1)
    const overlapRatio = Math.min(overlapCount / Math.max(clusterSize, 1), 1);
    const overlapScore = overlapRatio * 40;

    // Cluster size score — log scale, capped at 20 wallets → 30pts
    const sizeScore = Math.min(Math.log2(Math.max(clusterSize, 1)) / Math.log2(20), 1) * 30;

    // Historical hit score — 3+ hits → full score
    const hitScore = Math.min(cluster.cabalHitCount / 3, 1) * 20;

    // Blacklist bonus
    const blacklistScore = this.blacklistedClusters.has(cluster.id) ? 10 : 0;

    const total = Math.round(overlapScore + sizeScore + hitScore + blacklistScore);
    return Math.min(total, 100);
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Deterministic cluster ID from a set of wallets (sorted + hashed).
   */
  private computeClusterId(wallets: Set<WalletAddress>): string {
    const sorted = Array.from(wallets).sort();
    // Simple but deterministic hash: join and hash
    // Using a lightweight hash to avoid crypto dependency in hot path
    let hash = 0;
    const joined = sorted.join('|');
    for (let i = 0; i < joined.length; i++) {
      const ch = joined.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return `c${Math.abs(hash).toString(36)}_${sorted.length}`;
  }

  /**
   * Return an empty analysis result (no cabal detected).
   */
  private emptyResult(): CabalAnalysisResult {
    return {
      cabalScore: 0,
      clusterSize: 0,
      wallets: [],
      isCabal: false,
      clusterIds: [],
    };
  }

  // -------------------------------------------------------------------------
  // Periodic cleanup
  // -------------------------------------------------------------------------

  /**
   * Purge token/wallet entries outside the rolling window.
   */
  private purgeStale(): void {
    const cutoff = nowMs() - this.coOccurrenceWindowMs;

    // Purge stale token → wallet entries
    for (const [mint, wallets] of this.tokenWallets) {
      for (const [wallet, ts] of wallets) {
        if (ts < cutoff) {
          wallets.delete(wallet);
        }
      }
      if (wallets.size === 0) {
        this.tokenWallets.delete(mint);
      }
    }

    // Rebuild wallet → tokens from remaining data
    this.walletTokens.clear();
    for (const [mint, wallets] of this.tokenWallets) {
      for (const wallet of wallets.keys()) {
        let tokens = this.walletTokens.get(wallet);
        if (tokens === undefined) {
          tokens = new Set();
          this.walletTokens.set(wallet, tokens);
        }
        tokens.add(mint);
      }
    }

    logger.debug('Cabal detector cleanup complete', {
      trackedTokens: this.tokenWallets.size,
      trackedWallets: this.walletTokens.size,
      clusters: this.clusterCache.size,
      blacklistedClusters: this.blacklistedClusters.size,
    });
  }
}
