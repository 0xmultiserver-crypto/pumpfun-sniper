/**
 * Bundle Detector
 *
 * Detects bundled token purchases where a cluster of wallets buys a large
 * percentage of supply in a short early window. Clusters wallets by:
 *   (a) same-block purchases (same slot)
 *   (b) same funding source (wallets funded from the same parent wallet)
 *
 * Calculates bundlePct = total tokens bought by clustered wallets / total supply * 100
 * Emits a BUNDLE signal when bundlePct exceeds the configurable threshold (default 30%).
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { BundleSignal } from '../../core/types/signal.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { UnionFind } from '../../core/utils/unionFind.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Gauge } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:bundle');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const bundleDetectionsCounter = new Counter({
  name: 'pumpfun_bundle_detector_detections_total',
  help: 'Total bundle detections emitted by the bundle detector',
  registers: [register],
});

const bundlePctGauge = new Gauge({
  name: 'pumpfun_bundle_detector_latest_pct',
  help: 'Bundle percentage from the most recent analysis',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the bundle detector. */
export interface BundleDetectorConfig {
  /** Early window in seconds from first buy. Default: 60. */
  readonly windowSeconds?: number;
  /** Max bundle percentage before emitting signal. Default: 30. */
  readonly maxBundlePct?: number;
  /** Minimum buy count to analyze. Default: 5. */
  readonly minBuyCount?: number;
  /** Cooldown per mint in ms before re-emitting. Default: 120_000 (2 min). */
  readonly cooldownMs?: number;
}

/** A single buy event for bundle analysis. */
export interface BundleBuyEvent {
  readonly mint: MintAddress;
  readonly wallet: string;
  readonly slot: number;
  readonly timestamp: number;
  /** Amount of tokens bought (in smallest unit). */
  readonly tokenAmount: bigint;
  /** Optional: the funding wallet that funded this buyer wallet. */
  readonly fundingWallet?: string;
}

/** Internal buy record stored per token. */
interface BuyRecord {
  readonly wallet: string;
  readonly slot: number;
  readonly timestamp: number;
  readonly tokenAmount: bigint;
  readonly fundingWallet?: string;
}

/** Per-token tracking state. */
interface TokenBundleState {
  /** Timestamp of the first buy (defines the early window start). */
  readonly windowStart: number;
  /** All buys within the early window. */
  buys: BuyRecord[];
  /** Last time a bundle signal was emitted for this token. */
  lastSignalAt: number;
  /** Whether the window has closed (we already computed or it expired). */
  windowClosed: boolean;
}

// ---------------------------------------------------------------------------
// BundleDetector
// ---------------------------------------------------------------------------

export class BundleDetector implements IDetector {
  readonly name = 'bundle-detector';

  private readonly handlers: SignalHandler[] = [];
  private readonly tokenStates = new Map<MintAddress, TokenBundleState>();
  private running = false;
  private signalCounter = 0;

  private readonly windowMs: number;
  private readonly maxBundlePct: number;
  private readonly minBuyCount: number;
  private readonly cooldownMs: number;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: BundleDetectorConfig) {
    this.windowMs = (config?.windowSeconds ?? 60) * 1000;
    this.maxBundlePct = config?.maxBundlePct ?? 30;
    this.minBuyCount = config?.minBuyCount ?? 2;
    this.cooldownMs = config?.cooldownMs ?? 120_000;
  }

  // -------------------------------------------------------------------------
  // IDetector implementation
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeStaleTokens();
    }, 30_000);

    logger.info('Bundle detector started', {
      windowMs: this.windowMs,
      maxBundlePct: this.maxBundlePct,
      minBuyCount: this.minBuyCount,
      cooldownMs: this.cooldownMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokenStates.clear();
    logger.info('Bundle detector stopped');
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get the latest bundle percentage for a mint.
   * Returns null if no data available.
   */
  getLatestBundlePct(mint: string): number | null {
    const state = this.tokenStates.get(mint as MintAddress);
    if (!state || state.buys.length < 3) return null;
    return this.analyzeBundle(mint as MintAddress, state);
  }

  // -------------------------------------------------------------------------
  // Public API — called from ingestion pipeline
  // -------------------------------------------------------------------------

  /**
   * Process a buy event for bundle detection.
   * Only buy events are relevant — sells are ignored.
   */
  handleBuy(event: BundleBuyEvent): void {
    if (!this.running) return;

    let state = this.tokenStates.get(event.mint);
    if (state === undefined) {
      state = {
        windowStart: event.timestamp,
        buys: [],
        lastSignalAt: 0,
        windowClosed: false,
      };
      this.tokenStates.set(event.mint, state);
    }

    // If the window is still open and the event is within the window, record it
    if (!state.windowClosed && event.timestamp - state.windowStart <= this.windowMs) {
      state.buys.push({
        wallet: event.wallet,
        slot: event.slot,
        timestamp: event.timestamp,
        tokenAmount: event.tokenAmount,
        fundingWallet: event.fundingWallet,
      });
    }

    // If the window just closed (first buy outside window or enough time elapsed),
    // compute the bundle analysis
    if (!state.windowClosed) {
      // Use event-time only for window closure. Real-time check was removed
      // because under processing delays, real-time could close the window
      // before all early-window events arrived, causing understated bundle%.
      if (event.timestamp - state.windowStart > this.windowMs) {
        state.windowClosed = true;
        this.analyzeBundle(event.mint, state);
      }
    }
  }

  /**
   * Force-analyze a token's bundle state (e.g., at migration or when
   * the caller wants an immediate check). Returns the bundle pct.
   */
  forceAnalyze(mint: MintAddress): number {
    const state = this.tokenStates.get(mint);
    if (state === undefined || state.buys.length < 1) {
      return 0;
    }

    return this.analyzeBundle(mint, state);
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze buys for a mint, identify bundled wallets, and emit signal if threshold met.
   * Returns the computed bundlePct.
   */
  private analyzeBundle(mint: MintAddress, state: TokenBundleState): number {
    const buys = state.buys;
    if (buys.length < this.minBuyCount) return 0;

    // Calculate total tokens across all buys
    let totalTokenAmount = 0n;
    for (const buy of buys) {
      totalTokenAmount += buy.tokenAmount;
    }
    if (totalTokenAmount === 0n) return 0;

    // 1. Cluster wallets by same-slot (same block)
    const slotClusters = this.buildSlotClusters(buys);

    // 2. Cluster wallets by same funding source
    const fundingClusters = this.buildFundingClusters(buys);

    // 3. Merge clusters: union-find over both clustering methods
    const mergedClusters = this.mergeClusters(slotClusters, fundingClusters);

    // 4. Find the cluster with the highest token percentage
    let bestCluster: Set<string> = new Set();
    let bestClusterPct = 0;

    for (const cluster of mergedClusters) {
      let clusterTokens = 0n;
      for (const buy of buys) {
        if (cluster.has(buy.wallet)) {
          clusterTokens += buy.tokenAmount;
        }
      }
      const pct = Number((clusterTokens * 10000n) / totalTokenAmount) / 100;
      if (pct > bestClusterPct) {
        bestClusterPct = pct;
        bestCluster = cluster;
      }
    }

    // 5. Also check single-wallet "bundles": one wallet buying many times in same slot
    // This catches the case where a single wallet buys many times (no multi-wallet cluster)
    const walletTokenAmounts = new Map<string, bigint>();
    for (const buy of buys) {
      walletTokenAmounts.set(buy.wallet, (walletTokenAmounts.get(buy.wallet) ?? 0n) + buy.tokenAmount);
    }

    // Check if any single wallet bought more than the threshold
    for (const [wallet, tokens] of walletTokenAmounts) {
      const pct = Number((tokens * 10000n) / totalTokenAmount) / 100;
      if (pct > bestClusterPct) {
        bestClusterPct = pct;
        bestCluster = new Set([wallet]);
      }
    }

    // 6. Also check slot-level aggregation: all buys in same slot
    // This handles cases where multiple wallets buy in the same slot but
    // the cluster approach doesn't catch them (e.g., only 1 wallet per slot)
    const slotTokenAmounts = new Map<number, bigint>();
    const slotWallets = new Map<number, Set<string>>();
    for (const buy of buys) {
      slotTokenAmounts.set(buy.slot, (slotTokenAmounts.get(buy.slot) ?? 0n) + buy.tokenAmount);
      let set = slotWallets.get(buy.slot);
      if (set === undefined) {
        set = new Set();
        slotWallets.set(buy.slot, set);
      }
      set.add(buy.wallet);
    }

    for (const [slot, tokens] of slotTokenAmounts) {
      const pct = Number((tokens * 10000n) / totalTokenAmount) / 100;
      if (pct > bestClusterPct) {
        bestClusterPct = pct;
        bestCluster = slotWallets.get(slot)!;
      }
    }

    const bundlePct = bestClusterPct;
    bundlePctGauge.set(bundlePct);

    const windowMs = buys[buys.length - 1]!.timestamp - state.windowStart;

    if (bundlePct > this.maxBundlePct) {
      const now = nowMs();
      if (now - state.lastSignalAt >= this.cooldownMs) {
        state.lastSignalAt = now;

        logger.info(
          `Bundle detected: ${bestCluster.size} wallet(s) bought ${bundlePct.toFixed(1)}% supply in ${windowMs}ms`,
          {
            mint: mint.slice(0, 12),
            bundlePct: bundlePct.toFixed(2),
            clusteredWalletCount: bestCluster.size,
            totalBuyCount: buys.length,
            windowMs,
          },
        );

        this.emitBundleSignal(mint, bundlePct, bestCluster.size, buys.length, windowMs);
      }
    }

    return bundlePct;
  }

  /**
   * Build clusters of wallets that bought in the same slot.
   * Returns an array of sets, each set = wallets that bought in a particular slot.
   */
  private buildSlotClusters(buys: BuyRecord[]): Array<Set<string>> {
    const slotMap = new Map<number, Set<string>>();
    for (const buy of buys) {
      let set = slotMap.get(buy.slot);
      if (set === undefined) {
        set = new Set();
        slotMap.set(buy.slot, set);
      }
      set.add(buy.wallet);
    }
    // Only return clusters with 2+ wallets (a single wallet in a slot isn't a cluster)
    const clusters: Array<Set<string>> = [];
    for (const set of slotMap.values()) {
      if (set.size >= 2) {
        clusters.push(set);
      }
    }
    return clusters;
  }

  /**
   * Build clusters of wallets that share the same funding source.
   * Returns an array of sets, each set = wallets funded by the same parent.
   */
  private buildFundingClusters(buys: BuyRecord[]): Array<Set<string>> {
    const fundingMap = new Map<string, Set<string>>();
    for (const buy of buys) {
      if (buy.fundingWallet !== undefined && buy.fundingWallet !== '') {
        let set = fundingMap.get(buy.fundingWallet);
        if (set === undefined) {
          set = new Set();
          fundingMap.set(buy.fundingWallet, set);
        }
        set.add(buy.wallet);
      }
    }
    const clusters: Array<Set<string>> = [];
    for (const set of fundingMap.values()) {
      if (set.size >= 2) {
        clusters.push(set);
      }
    }
    return clusters;
  }

  /**
   * Merge clusters from different sources using union-find.
   * If two clusters share any wallet, they are merged into one.
   */
  private mergeClusters(
    ...clusterSources: Array<Array<Set<string>>>
  ): Array<Set<string>> {
    // Flatten all clusters
    const allClusters: Array<Set<string>> = [];
    for (const source of clusterSources) {
      allClusters.push(...source);
    }

    if (allClusters.length === 0) {
      return [];
    }

    const uf = new UnionFind();

    // For each cluster, union all wallets together
    for (const cluster of allClusters) {
      const wallets = [...cluster];
      if (wallets.length === 0) continue;

      const first = wallets[0]!;
      for (let i = 1; i < wallets.length; i++) {
        uf.union(first, wallets[i]!);
      }
    }

    // Return only clusters with 2+ wallets
    return uf.getConnectedComponents(2);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emitBundleSignal(
    mint: MintAddress,
    bundlePct: number,
    clusteredWalletCount: number,
    totalBuyCount: number,
    windowMs: number,
  ): void {
    this.signalCounter += 1;
    const signalId = `bundle-${this.signalCounter}-${nowMs()}`;

    const signal: BundleSignal = {
      id: signalId,
      type: 'BUNDLE',
      mint,
      timestamp: nowMs(),
      slot: 0, // Bundle signals span multiple slots — use 0
      bundlePct,
      clusteredWalletCount,
      totalBuyCount,
      windowMs,
    };

    logger.debug('Bundle signal emitted', {
      signalId,
      mint,
      bundlePct: bundlePct.toFixed(2),
      clusteredWalletCount,
      totalBuyCount,
      windowMs,
    });

    bundleDetectionsCounter.inc();

    for (const handler of this.handlers) {
      try {
        handler(signal);
      } catch (err: unknown) {
        logger.error('Signal handler threw', {
          signalId: signal.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private purgeStaleTokens(): void {
    const cutoff = nowMs() - this.windowMs * 3;
    for (const [mint, state] of this.tokenStates) {
      // Remove tokens whose window closed and are stale
      if (state.windowClosed) {
        const latestBuy = state.buys[state.buys.length - 1];
        if (latestBuy === undefined || latestBuy.timestamp < cutoff) {
          this.tokenStates.delete(mint);
        }
      } else {
        // If the window hasn't closed but the windowStart is way past, force-close
        if (nowMs() - state.windowStart > this.windowMs * 2) {
          state.windowClosed = true;
          this.analyzeBundle(mint, state);
          // After analysis, if still stale (buys all old), it'll get cleaned next cycle
        }
      }
    }
  }
}
