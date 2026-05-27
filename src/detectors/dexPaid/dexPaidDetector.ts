/**
 * Dex Paid Timing Detector (Phase 3.3)
 *
 * Tracks whether and when a token got its DexScreener "paid" listing.
 * If the dex paid timestamp is significantly later than the token launch
 * timestamp (>30 minutes), the token is flagged as suspicious.
 *
 * Data source: DexScreener API
 *   GET https://api.dexscreener.com/latest/dex/tokens/{mint}
 *
 * Raw event → signal ONLY. No buy decisions, no risk logic, no DB persistence.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter, Histogram } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:dexPaid');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const dexPaidChecksTotal = new Counter({
  name: 'pumpfun_dexpaid_checks_total',
  help: 'Total DexScreener paid status checks performed',
  labelNames: ['outcome'] as const,
  registers: [register],
});

const dexPaidLateDetections = new Counter({
  name: 'pumpfun_dexpaid_late_detections_total',
  help: 'Total tokens flagged as late dex paid',
  registers: [register],
});

const dexPaidGapMinutes = new Histogram({
  name: 'pumpfun_dexpaid_gap_minutes',
  help: 'Distribution of dex paid gap (minutes from launch to dex paid)',
  buckets: [1, 5, 10, 15, 30, 60, 120, 240],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gap threshold in minutes — if dex paid is this late, flag as suspicious. */
const LATE_DEX_PAID_THRESHOLD_MINUTES = 30;

/** DexScreener API base URL for token lookups. */
const DEXSCREENER_API_BASE = 'https://api.dexscreener.com/latest/dex/tokens';

/** HTTP request timeout for DexScreener API in milliseconds. */
const DEXSCREENER_REQUEST_TIMEOUT_MS = 10_000;

/** Cache TTL for dex paid results in milliseconds (5 minutes). */
const DEXPAID_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum number of cached results. */
const MAX_CACHE_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the DexPaid detector. */
export interface DexPaidDetectorConfig {
  /** Gap threshold in minutes. Default: 30. */
  readonly lateThresholdMinutes?: number;
  /** Cache TTL in milliseconds. Default: 300_000 (5 min). */
  readonly cacheTtlMs?: number;
  /** Max cached entries. Default: 1000. */
  readonly maxCacheSize?: number;
}

/** Result of a dex paid check. */
export interface DexPaidResult {
  /** Whether the token has a paid listing on DexScreener. */
  readonly isPaid: boolean;
  /** Timestamp (ms) when the dex paid listing was created, or null. */
  readonly paidTimestamp: number | null;
  /** Whether the dex paid happened later than the threshold. */
  readonly isLate: boolean;
  /** Gap in minutes between launch and dex paid (negative = paid before launch). */
  readonly gapMinutes: number;
}

/** Cached entry for a dex paid check. */
interface CachedDexPaidResult {
  readonly result: DexPaidResult;
  readonly cachedAt: number;
}

// ---------------------------------------------------------------------------
// DexScreener API response types (subset we care about)
// ---------------------------------------------------------------------------

interface DexScreenerPair {
  readonly chainId?: string;
  readonly dexId?: string;
  readonly url?: string;
  readonly pairAddress?: string;
  readonly baseToken?: {
    readonly address?: string;
    readonly name?: string;
    readonly symbol?: string;
  };
  readonly createdAt?: number;
  readonly info?: {
    readonly imageUrl?: string;
    readonly websites?: ReadonlyArray<{ readonly url?: string }>;
    readonly socials?: ReadonlyArray<{ readonly platform?: string; readonly handle?: string }>;
  };
  readonly boosts?: {
    readonly active?: number;
  };
}

interface DexScreenerResponse {
  readonly schemaVersion?: string;
  readonly pairs?: ReadonlyArray<DexScreenerPair> | null;
}

// ---------------------------------------------------------------------------
// DexPaidDetector
// ---------------------------------------------------------------------------

export class DexPaidDetector implements IDetector {
  readonly name = 'dex-paid-detector';

  private readonly handlers: SignalHandler[] = [];

  private readonly lateThresholdMinutes: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheSize: number;

  /** Result cache keyed by mint address. */
  private readonly cache = new Map<MintAddress, CachedDexPaidResult>();

  private running = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: DexPaidDetectorConfig) {
    this.lateThresholdMinutes = config?.lateThresholdMinutes ?? LATE_DEX_PAID_THRESHOLD_MINUTES;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEXPAID_CACHE_TTL_MS;
    this.maxCacheSize = config?.maxCacheSize ?? MAX_CACHE_SIZE;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.cleanupTimer = setInterval(() => {
      this.purgeExpiredCache();
    }, 60_000);

    logger.info('DexPaid detector started', {
      lateThresholdMinutes: this.lateThresholdMinutes,
      cacheTtlMs: this.cacheTtlMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.cache.clear();
    logger.info('DexPaid detector stopped');
  }

  // -----------------------------------------------------------------------
  // IDetector — onSignal
  // -----------------------------------------------------------------------

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Check whether a token has a paid DexScreener listing and whether the
   * timing is suspicious relative to the token's launch timestamp.
   *
   * @param mint  The token mint address.
   * @param launchTimestamp  Token launch timestamp in milliseconds.
   * @returns  DexPaidResult with timing analysis.
   */
  async checkDexPaid(mint: MintAddress, launchTimestamp: number): Promise<DexPaidResult> {
    if (!this.running) {
      logger.warn('checkDexPaid called while detector is not running', { mint });
      return this.buildDefaultResult();
    }

    // Check cache first
    const cached = this.cache.get(mint);
    if (cached !== undefined && nowMs() - cached.cachedAt < this.cacheTtlMs) {
      logger.debug('DexPaid cache hit', { mint: mint.slice(0, 12) });
      return cached.result;
    }

    try {
      const result = await this.fetchAndAnalyze(mint, launchTimestamp);

      // Update cache (evict oldest if at capacity)
      if (this.cache.size >= this.maxCacheSize) {
        this.evictOldestCacheEntry();
      }
      this.cache.set(mint, { result, cachedAt: nowMs() });

      dexPaidChecksTotal.inc({ outcome: result.isLate ? 'late' : result.isPaid ? 'paid' : 'unpaid' });

      if (result.isLate) {
        dexPaidLateDetections.inc();
        logger.warn('Late dex paid detected', {
          mint: mint.slice(0, 12),
          gapMinutes: result.gapMinutes,
          paidTimestamp: result.paidTimestamp,
        });
      }

      return result;
    } catch (err: unknown) {
      dexPaidChecksTotal.inc({ outcome: 'error' });
      logger.error('DexPaid check failed', {
        mint: mint.slice(0, 12),
        err: err instanceof Error ? err.message : String(err),
      });
      return this.buildDefaultResult();
    }
  }

  // -----------------------------------------------------------------------
  // Fetch & Analyze
  // -----------------------------------------------------------------------

  private async fetchAndAnalyze(
    mint: MintAddress,
    launchTimestamp: number,
  ): Promise<DexPaidResult> {
    const url = `${DEXSCREENER_API_BASE}/${mint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEXSCREENER_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`DexScreener API returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as DexScreenerResponse;
      return this.analyzeResponse(data, mint, launchTimestamp);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Analyze the DexScreener response to extract dex paid timing.
   *
   * DexScreener returns pairs for a token. We look for `createdAt` on the
   * pair entry, which indicates when the pair was created / indexed by
   * DexScreener (i.e., when the listing was "paid for"). The `boosts`
   * field also indicates active ad boosts.
   *
   * A token is considered "dex paid" when it has a pair entry with a
   * `createdAt` timestamp present on DexScreener.
   */
  private analyzeResponse(
    data: DexScreenerResponse,
    mint: MintAddress,
    launchTimestamp: number,
  ): DexPaidResult {
    const pairs = data.pairs;
    if (pairs === null || pairs === undefined || pairs.length === 0) {
      logger.debug('No DexScreener pairs found', { mint: mint.slice(0, 12) });
      return {
        isPaid: false,
        paidTimestamp: null,
        isLate: false,
        gapMinutes: 0,
      };
    }

    // Find the earliest pair creation timestamp for this token on Solana
    let earliestPairTimestamp: number | null = null;

    for (const pair of pairs) {
      // Only consider Solana pairs
      if (pair.chainId !== 'solana') continue;

      const pairCreatedAt = pair.createdAt;
      if (pairCreatedAt !== undefined && pairCreatedAt > 0) {
        // DexScreener createdAt is in milliseconds
        if (earliestPairTimestamp === null || pairCreatedAt < earliestPairTimestamp) {
          earliestPairTimestamp = pairCreatedAt;
        }
      }
    }

    if (earliestPairTimestamp === null) {
      logger.debug('DexScreener pairs found but no createdAt timestamp', {
        mint: mint.slice(0, 12),
        pairCount: pairs.length,
      });
      return {
        isPaid: false,
        paidTimestamp: null,
        isLate: false,
        gapMinutes: 0,
      };
    }

    // Calculate gap between launch and dex paid
    const gapMs = earliestPairTimestamp - launchTimestamp;
    const gapMinutes = gapMs / (1000 * 60);

    // Record the gap in the histogram
    dexPaidGapMinutes.observe(Math.abs(gapMinutes));

    const isLate = gapMinutes > this.lateThresholdMinutes;

    logger.info('DexPaid analysis complete', {
      mint: mint.slice(0, 12),
      isPaid: true,
      paidTimestamp: earliestPairTimestamp,
      launchTimestamp,
      gapMinutes: gapMinutes.toFixed(1),
      isLate,
      threshold: this.lateThresholdMinutes,
    });

    return {
      isPaid: true,
      paidTimestamp: earliestPairTimestamp,
      isLate,
      gapMinutes,
    };
  }

  // -----------------------------------------------------------------------
  // Cache Management
  // -----------------------------------------------------------------------

  private purgeExpiredCache(): void {
    const now = nowMs();
    for (const [mint, entry] of this.cache) {
      if (now - entry.cachedAt >= this.cacheTtlMs) {
        this.cache.delete(mint);
      }
    }
  }

  private evictOldestCacheEntry(): void {
    let oldestMint: MintAddress | null = null;
    let oldestTime = Infinity;

    for (const [mint, entry] of this.cache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestMint = mint;
      }
    }

    if (oldestMint !== null) {
      this.cache.delete(oldestMint);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildDefaultResult(): DexPaidResult {
    return {
      isPaid: false,
      paidTimestamp: null,
      isLate: false,
      gapMinutes: 0,
    };
  }
}
