/**
 * Holder Concentration Analyzer (Phase 4.3)
 *
 * Enhances wallet concentration checks with wallet clustering.
 * Groups wallets that were funded from the same source wallet,
 * treating them as a single entity for concentration calculations.
 *
 * This catches sybil-style setups where a deployer distributes
 * tokens across many wallets to hide true ownership.
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import { UnionFind } from '../../core/utils/unionFind.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { Counter } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:concentrationAnalyzer');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const concentrationChecksTotal = new Counter({
  name: 'pumpfun_concentration_checks_total',
  help: 'Total holder concentration analyses performed',
  registers: [register],
});

const concentrationRejectionsTotal = new Counter({
  name: 'pumpfun_concentration_rejections_total',
  help: 'Total tokens rejected due to high effective concentration',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum effective concentration before rejecting (40%). */
const MAX_CONCENTRATION_PCT = 40;

/** Maximum age for funding source records (ms). Default: 24 hours. */
const MAX_FUNDING_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;

/** Cleanup interval for stale funding records (ms). */
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the ConcentrationAnalyzer. */
export interface ConcentrationAnalyzerConfig {
  /** Maximum effective concentration % before rejecting. Default: 40. */
  readonly maxConcentrationPct?: number;
  /** Max age for funding source records in ms. Default: 86400000 (24h). */
  readonly maxFundingSourceAgeMs?: number;
}

/** A holder with their wallet address and percentage owned. */
export interface Holder {
  readonly wallet: string;
  readonly pctOwned: number;
}

/** A cluster of wallets funded from the same source. */
export interface WalletCluster {
  /** The funding source wallet (cluster root). */
  readonly fundingSource: string;
  /** All wallets in this cluster (including the source if it holds tokens). */
  readonly wallets: ReadonlyArray<string>;
  /** Combined token ownership % for all wallets in the cluster. */
  readonly combinedPct: number;
}

/** Result returned by analyzeConcentration(). */
export interface ConcentrationResult {
  /** The highest cluster concentration % (the effective concentration). */
  readonly effectiveConcentration: number;
  /** All detected wallet clusters with their combined holdings. */
  readonly clusters: ReadonlyArray<WalletCluster>;
  /** Whether the effective concentration exceeds the threshold. */
  readonly isConcentrated: boolean;
}

// ---------------------------------------------------------------------------
// ConcentrationAnalyzer
// ---------------------------------------------------------------------------

export class ConcentrationAnalyzer implements IDetector {
  readonly name = 'concentration-analyzer';

  private readonly handlers: SignalHandler[] = [];

  private readonly maxConcentrationPct: number;
  private readonly maxFundingSourceAgeMs: number;

  /**
   * Funding source graph: wallet → source wallet.
   * Populated externally via recordFunding().
   */
  private readonly fundingSources = new Map<string, string>();

  /** Reverse index: source wallet → Set of wallets it funded. */
  private readonly sourceToFunded = new Map<string, Set<string>>();

  /** Timestamps for funding records (for TTL eviction). */
  private readonly fundingTimestamps = new Map<string, number>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config?: ConcentrationAnalyzerConfig) {
    this.maxConcentrationPct = config?.maxConcentrationPct ?? MAX_CONCENTRATION_PCT;
    this.maxFundingSourceAgeMs = config?.maxFundingSourceAgeMs ?? MAX_FUNDING_SOURCE_AGE_MS;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStaleRecords();
    }, CLEANUP_INTERVAL_MS);

    logger.info('ConcentrationAnalyzer started', {
      maxConcentrationPct: this.maxConcentrationPct,
      maxFundingSourceAgeMs: this.maxFundingSourceAgeMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.fundingSources.clear();
    this.sourceToFunded.clear();
    this.fundingTimestamps.clear();

    logger.info('ConcentrationAnalyzer stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Public API — Funding Source Recording
  // -------------------------------------------------------------------------

  /**
   * Record a funding relationship: sourceWallet sent SOL to wallet.
   * This data is used to cluster wallets during concentration analysis.
   *
   * @param wallet        The wallet that received SOL.
   * @param sourceWallet  The wallet that sent SOL.
   * @param timestamp     Transaction timestamp (ms).
   */
  recordFunding(wallet: string, sourceWallet: string, timestamp: number): void {
    if (!this.running) return;

    // Don't overwrite if already funded by someone (first funder wins)
    if (this.fundingSources.has(wallet)) {
      // But track additional sources for the reverse index
      const existing = this.sourceToFunded.get(sourceWallet);
      if (existing !== undefined) {
        existing.add(wallet);
      } else {
        this.sourceToFunded.set(sourceWallet, new Set([wallet]));
      }
      return;
    }

    this.fundingSources.set(wallet, sourceWallet);
    this.fundingTimestamps.set(wallet, timestamp);

    const existing = this.sourceToFunded.get(sourceWallet);
    if (existing !== undefined) {
      existing.add(wallet);
    } else {
      this.sourceToFunded.set(sourceWallet, new Set([wallet]));
    }

    logger.debug('Recorded funding relationship', {
      wallet: wallet.slice(0, 8),
      source: sourceWallet.slice(0, 8),
    });
  }

  // -------------------------------------------------------------------------
  // Public API — Concentration Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze holder concentration for a token, clustering wallets
   * that share the same funding source.
   *
   * @param mint    The token mint address.
   * @param holders Array of holders with wallet address and % owned.
   * @returns       ConcentrationResult with effective concentration and clusters.
   */
  analyzeConcentration(mint: MintAddress, holders: ReadonlyArray<Holder>): ConcentrationResult {
    if (!this.running) {
      logger.warn('analyzeConcentration called while not running', { mint });
      concentrationChecksTotal.inc();
      return this.buildDefaultResult();
    }

    concentrationChecksTotal.inc();

    // Build clusters from the funding source graph
    const clusters = this.buildClusters(holders);

    // Find the maximum cluster concentration
    let effectiveConcentration = 0;
    for (const cluster of clusters) {
      if (cluster.combinedPct > effectiveConcentration) {
        effectiveConcentration = cluster.combinedPct;
      }
    }

    const isConcentrated = effectiveConcentration > this.maxConcentrationPct;

    if (isConcentrated) {
      concentrationRejectionsTotal.inc();
      logger.warn('Token REJECTED — high effective concentration', {
        mint: mint.slice(0, 12),
        effectiveConcentration: effectiveConcentration.toFixed(2),
        threshold: this.maxConcentrationPct,
        clusterCount: clusters.length,
        topCluster: clusters[0]?.fundingSource.slice(0, 8) ?? 'none',
      });
    } else {
      logger.debug('Concentration check passed', {
        mint: mint.slice(0, 12),
        effectiveConcentration: effectiveConcentration.toFixed(2),
        clusterCount: clusters.length,
      });
    }

    return {
      effectiveConcentration,
      clusters,
      isConcentrated,
    };
  }

  // -------------------------------------------------------------------------
  // Cluster Building (Union-Find style)
  // -------------------------------------------------------------------------

  /**
   * Build wallet clusters by tracing funding sources.
   * Uses Union-Find to group wallets that share a common funding ancestor.
   */
  private buildClusters(holders: ReadonlyArray<Holder>): ReadonlyArray<WalletCluster> {
    const uf = new UnionFind();

    // Collect all wallets from holders
    const holderWallets = new Set(holders.map((h) => h.wallet));

    // For each holder wallet, check its funding source
    // If two holder wallets share the same funding source, union them
    const sourceToHolderWallets = new Map<string, string[]>();

    for (const holder of holders) {
      const source = this.fundingSources.get(holder.wallet);
      if (source !== undefined) {
        const existing = sourceToHolderWallets.get(source);
        if (existing !== undefined) {
          existing.push(holder.wallet);
        } else {
          sourceToHolderWallets.set(source, [holder.wallet]);
        }
      }
    }

    // Union wallets that share the same funding source
    for (const [, wallets] of sourceToHolderWallets) {
      if (wallets.length > 1) {
        const first = wallets[0]!;
        for (let i = 1; i < wallets.length; i++) {
          uf.union(first, wallets[i]!);
        }
      }
    }

    // Also check if the funding source itself is a holder
    for (const source of sourceToHolderWallets.keys()) {
      if (holderWallets.has(source)) {
        const wallets = sourceToHolderWallets.get(source);
        if (wallets !== undefined && wallets.length > 0) {
          uf.union(source, wallets[0]!);
        }
      }
    }

    // Build clusters from the Union-Find structure
    const clusterMap = new Map<string, { wallets: string[]; combinedPct: number; fundingSource: string }>();

    for (const holder of holders) {
      const root = uf.find(holder.wallet);

      let cluster = clusterMap.get(root);
      if (cluster === undefined) {
        // Determine the funding source for this cluster
        const fundingSource = this.findClusterFundingSource(holder.wallet);
        cluster = { wallets: [], combinedPct: 0, fundingSource };
        clusterMap.set(root, cluster);
      }

      cluster.wallets.push(holder.wallet);
      cluster.combinedPct += holder.pctOwned;
    }

    // Convert to array and sort by combined percentage (highest first)
    const result: WalletCluster[] = [];
    for (const [, cluster] of clusterMap) {
      result.push({
        fundingSource: cluster.fundingSource,
        wallets: cluster.wallets,
        combinedPct: cluster.combinedPct,
      });
    }

    result.sort((a, b) => b.combinedPct - a.combinedPct);

    return result;
  }

  /**
   * Find the funding source for a cluster by tracing the wallet's funding chain.
   * Falls back to the root wallet if no funding source is known.
   */
  private findClusterFundingSource(wallet: string): string {
    // Walk up the funding chain to find the topmost source
    const visited = new Set<string>();
    let current = wallet;
    let lastSource = wallet;

    while (true) {
      if (visited.has(current)) break;
      visited.add(current);

      const source = this.fundingSources.get(current);
      if (source === undefined) break;

      lastSource = source;
      current = source;
    }

    return lastSource;
  }

  // -------------------------------------------------------------------------
  // Default result for when analyzer is not running
  // -------------------------------------------------------------------------

  private buildDefaultResult(): ConcentrationResult {
    return {
      effectiveConcentration: 0,
      clusters: [],
      isConcentrated: false,
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private purgeStaleRecords(): void {
    const cutoff = nowMs() - this.maxFundingSourceAgeMs;
    let purged = 0;

    for (const [wallet, timestamp] of this.fundingTimestamps) {
      if (timestamp < cutoff) {
        const source = this.fundingSources.get(wallet);
        this.fundingSources.delete(wallet);
        this.fundingTimestamps.delete(wallet);

        // Clean up reverse index
        if (source !== undefined) {
          const funded = this.sourceToFunded.get(source);
          if (funded !== undefined) {
            funded.delete(wallet);
            if (funded.size === 0) {
              this.sourceToFunded.delete(source);
            }
          }
        }

        purged++;
      }
    }

    if (purged > 0) {
      logger.debug('Purged stale funding records', {
        purged,
        remaining: this.fundingSources.size,
      });
    }
  }
}
