/**
 * Day Phase Detector (Phase 5.2)
 *
 * Detects tokens in a "cooldown" / sideways phase after a significant dump.
 * These tokens have potential for a second leg up once consolidation completes.
 *
 * Criteria for day-phase detection:
 *   1. FDV (Fully Diluted Valuation) > $1M  — token has meaningful market cap
 *   2. Price dipped 50-70% from ATH         — significant correction occurred
 *   3. Sideways for 3-5 days                 — consolidation / accumulation
 *   4. Holder count stable or increasing     — no mass exodus
 *
 * Analyser only — no buy decisions, no risk logic, no DB persistence.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { IDetector, SignalHandler } from '../../core/interfaces/detector.js';
import type { DayPhaseSignal } from '../../core/types/signal.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { Counter } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('detectors:dayPhase');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const dayPhaseChecksTotal = new Counter({
  name: 'pumpfun_dayphase_checks_total',
  help: 'Total day-phase analysis checks performed',
  registers: [register],
});

const dayPhaseDetectionsTotal = new Counter({
  name: 'pumpfun_dayphase_detections_total',
  help: 'Total tokens flagged as being in day-phase cooldown',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the day phase detector thresholds. */
export interface DayPhaseDetectorConfig {
  /** Minimum FDV in USD to consider a token. Default: 1_000_000. */
  readonly minFdvUsd?: number;
  /** Minimum dip from ATH percentage (0-100). Default: 50. */
  readonly minAthDipPct?: number;
  /** Maximum dip from ATH percentage (0-100). Default: 70. */
  readonly maxAthDipPct?: number;
  /** Minimum sideways duration in days. Default: 3. */
  readonly minSidewaysDays?: number;
  /** Maximum sideways duration in days to still qualify. Default: 5. */
  readonly maxSidewaysDays?: number;
  /** Maximum holder count change percentage to consider "stable" (negative = declining). Default: -5. */
  readonly maxHolderDeclinePct?: number;
}

/** Token data required for day-phase analysis. */
export interface DayPhaseTokenData {
  /** Current fully diluted valuation in USD. */
  readonly fdvUsd: number;
  /** All-time high price in USD. */
  readonly athPriceUsd: number;
  /** Current price in USD. */
  readonly currentPriceUsd: number;
  /** Timestamp (ms) when the ATH was reached. */
  readonly athTimestamp: number;
  /** Current holder count. */
  readonly holderCount: number;
  /** Holder count at the time of ATH. */
  readonly holderCountAtAth: number;
  /** Timestamp (ms) of the most recent price data point. */
  readonly lastPriceTimestamp: number;
  /** Price history entries (timestamp, price) for sideways detection. */
  readonly priceHistory?: ReadonlyArray<readonly [number, number]>;
}

/** Result of a day-phase analysis. */
export interface DayPhaseResult {
  /** Whether the token qualifies as being in a day-phase cooldown. */
  readonly isDayPhase: boolean;
  /** Current FDV in USD. */
  readonly fdv: number;
  /** Dip from ATH as a percentage (0-100). */
  readonly athDipPct: number;
  /** Number of days the token has been trading sideways. */
  readonly sidewaysDays: number;
  /** Holder trend: 'growing' | 'stable' | 'declining'. */
  readonly holderTrend: 'growing' | 'stable' | 'declining';
  /** Reasons the token did or did not qualify. */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// DayPhaseDetector
// ---------------------------------------------------------------------------

export class DayPhaseDetector implements IDetector {
  readonly name = 'day-phase-detector';

  private readonly handlers: SignalHandler[] = [];
  private signalCounter = 0;

  private readonly minFdvUsd: number;
  private readonly minAthDipPct: number;
  private readonly maxAthDipPct: number;
  private readonly minSidewaysDays: number;
  private readonly maxSidewaysDays: number;
  private readonly maxHolderDeclinePct: number;

  constructor(config?: DayPhaseDetectorConfig) {
    this.minFdvUsd = config?.minFdvUsd ?? 1_000_000;
    this.minAthDipPct = config?.minAthDipPct ?? 50;
    this.maxAthDipPct = config?.maxAthDipPct ?? 70;
    this.minSidewaysDays = config?.minSidewaysDays ?? 3;
    this.maxSidewaysDays = config?.maxSidewaysDays ?? 5;
    this.maxHolderDeclinePct = config?.maxHolderDeclinePct ?? -5;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    // Stateless analyzer — no-op
  }

  async stop(): Promise<void> {
    // Stateless analyzer — no-op
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  private emit(signal: DayPhaseSignal): void {
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

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Analyse whether a token is in a "day-phase" cooldown (sideways after dump).
   *
   * @param mint      The token mint address.
   * @param tokenData Token market data for analysis.
   * @returns         DayPhaseResult with detection details.
   */
  analyzeDayPhase(mint: MintAddress, tokenData: DayPhaseTokenData): DayPhaseResult {
    dayPhaseChecksTotal.inc();

    const reasons: string[] = [];

    // 1. FDV check
    if (tokenData.fdvUsd < this.minFdvUsd) {
      reasons.push(
        `FDV too low: $${tokenData.fdvUsd.toLocaleString()} < $${this.minFdvUsd.toLocaleString()}`,
      );
      return this.buildResult(false, tokenData, 0, 0, 'stable', reasons);
    }

    // 2. ATH dip calculation
    if (tokenData.athPriceUsd <= 0) {
      reasons.push('ATH price is zero or negative — cannot compute dip');
      return this.buildResult(false, tokenData, 0, 0, 'stable', reasons);
    }

    const athDipPct = ((tokenData.athPriceUsd - tokenData.currentPriceUsd) / tokenData.athPriceUsd) * 100;

    if (athDipPct < this.minAthDipPct) {
      reasons.push(
        `ATH dip too small: ${athDipPct.toFixed(1)}% < ${this.minAthDipPct}%`,
      );
      return this.buildResult(false, tokenData, athDipPct, 0, 'stable', reasons);
    }

    if (athDipPct > this.maxAthDipPct) {
      reasons.push(
        `ATH dip too large: ${athDipPct.toFixed(1)}% > ${this.maxAthDipPct}% — likely dead, not cooldown`,
      );
      return this.buildResult(false, tokenData, athDipPct, 0, 'stable', reasons);
    }

    // 3. Sideways detection
    const sidewaysDays = this.calculateSidewaysDays(tokenData);

    if (sidewaysDays < this.minSidewaysDays) {
      reasons.push(
        `Sideways duration too short: ${sidewaysDays.toFixed(1)}d < ${this.minSidewaysDays}d`,
      );
      return this.buildResult(false, tokenData, athDipPct, sidewaysDays, 'stable', reasons);
    }

    if (sidewaysDays > this.maxSidewaysDays) {
      reasons.push(
        `Sideways duration too long: ${sidewaysDays.toFixed(1)}d > ${this.maxSidewaysDays}d — may be abandoned`,
      );
      return this.buildResult(false, tokenData, athDipPct, sidewaysDays, 'stable', reasons);
    }

    // 4. Holder trend analysis
    const holderTrend = this.analyzeHolderTrend(tokenData);

    if (holderTrend === 'declining') {
      const holderChangePct = this.calculateHolderChangePct(tokenData);
      reasons.push(
        `Holder count declining: ${holderChangePct.toFixed(1)}% change (max allowed: ${this.maxHolderDeclinePct}%)`,
      );
      return this.buildResult(false, tokenData, athDipPct, sidewaysDays, holderTrend, reasons);
    }

    // All criteria met
    reasons.push('All day-phase criteria met');
    dayPhaseDetectionsTotal.inc();

    this.signalCounter += 1;
    this.emit({
      id: `dayphase-${this.signalCounter}-${nowMs()}`,
      type: 'DAY_PHASE',
      mint,
      timestamp: nowMs(),
      slot: 0,
      fdv: tokenData.fdvUsd,
      athDipPct,
      sidewaysDays,
      holderTrend,
    });

    logger.info('Day-phase cooldown detected', {
      mint: mint.slice(0, 12),
      fdv: tokenData.fdvUsd,
      athDipPct: athDipPct.toFixed(1),
      sidewaysDays: sidewaysDays.toFixed(1),
      holderTrend,
    });

    return this.buildResult(true, tokenData, athDipPct, sidewaysDays, holderTrend, reasons);
  }

  // -----------------------------------------------------------------------
  // Sideways Detection
  // -----------------------------------------------------------------------

  /**
   * Calculate the number of days the token has been trading sideways.
   *
   * Sideways = price staying within a ±15% band from the post-dip average.
   * If no price history is available, we estimate from ATH timestamp.
   */
  private calculateSidewaysDays(tokenData: DayPhaseTokenData): number {
    // If we have price history, use it for precise sideways detection
    if (tokenData.priceHistory !== undefined && tokenData.priceHistory.length >= 2) {
      return this.calculateSidewaysFromHistory(tokenData.priceHistory, tokenData.currentPriceUsd);
    }

    // Fallback: without price history, we cannot determine sideways movement.
    // Return 0 to avoid false positives — the detector requires actual data.
    return 0;
  }

  /**
   * Calculate sideways days from price history data.
   * Counts consecutive days where price stays within ±15% band.
   */
  private calculateSidewaysFromHistory(
    priceHistory: ReadonlyArray<readonly [number, number]>,
    currentPrice: number,
  ): number {
    if (priceHistory.length === 0) return 0;

    // Use the current price as the sideways centre
    const bandPct = 0.15; // ±15%
    const lowerBand = currentPrice * (1 - bandPct);
    const upperBand = currentPrice * (1 + bandPct);

    // Count how many days the price stayed in the band
    let inBandCount = 0;
    let totalDays = 0;

    // Group by day
    const dayBuckets = new Map<number, boolean>();
    const msPerDay = 1000 * 60 * 60 * 24;

    for (const [timestamp, price] of priceHistory) {
      const dayKey = Math.floor(timestamp / msPerDay);
      const inBand = price >= lowerBand && price <= upperBand;

      // Mark day as in-band if at least one data point is in band
      const existing = dayBuckets.get(dayKey);
      dayBuckets.set(dayKey, (existing ?? false) || inBand);
    }

    totalDays = dayBuckets.size;
    inBandCount = 0;
    for (const inBand of dayBuckets.values()) {
      if (inBand) inBandCount++;
    }

    // Require at least 70% of days in band to count as sideways
    if (totalDays > 0 && inBandCount / totalDays >= 0.7) {
      return totalDays;
    }

    return 0;
  }

  // -----------------------------------------------------------------------
  // Holder Trend
  // -----------------------------------------------------------------------

  /**
   * Determine holder trend from ATH holder count vs current.
   * Growing: > +5%, Stable: -5% to +5%, Declining: < -5%.
   */
  private analyzeHolderTrend(
    tokenData: DayPhaseTokenData,
  ): 'growing' | 'stable' | 'declining' {
    const changePct = this.calculateHolderChangePct(tokenData);

    if (changePct < this.maxHolderDeclinePct) {
      return 'declining';
    }
    if (changePct > 5) {
      return 'growing';
    }
    return 'stable';
  }

  private calculateHolderChangePct(tokenData: DayPhaseTokenData): number {
    if (tokenData.holderCountAtAth <= 0) return 0;
    return (
      ((tokenData.holderCount - tokenData.holderCountAtAth) / tokenData.holderCountAtAth) * 100
    );
  }

  // -----------------------------------------------------------------------
  // Result Builder
  // -----------------------------------------------------------------------

  private buildResult(
    isDayPhase: boolean,
    tokenData: DayPhaseTokenData,
    athDipPct: number,
    sidewaysDays: number,
    holderTrend: 'growing' | 'stable' | 'declining',
    reasons: readonly string[],
  ): DayPhaseResult {
    return Object.freeze({
      isDayPhase,
      fdv: tokenData.fdvUsd,
      athDipPct,
      sidewaysDays,
      holderTrend,
      reasons,
    });
  }
}
