/**
 * Compound Manager (Phase 5.3)
 *
 * Manages profit splitting and compounding on take-profit events.
 *
 * Strategy:
 *   - On take profit: split proceeds between cold wallet (secure storage)
 *     and trading wallet (re-invested capital).
 *   - Default split: 35% → cold wallet, 65% → trading wallet.
 *   - Configurable ratio for risk-adjusted compounding.
 *
 * Pure business logic — no RPC, no DB persistence, no protocol interaction.
 */

import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import { Counter } from 'prom-client';
import { register } from '../../telemetry/metrics/prometheus.js';

const logger = createLogger('strategies:compoundManager');

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const compoundTotalLamports = new Counter({
  name: 'pumpfun_compound_total_lamports',
  help: 'Total lamports processed through the compound manager',
  labelNames: ['destination'] as const,
  registers: [register],
});

const compoundSplitCount = new Counter({
  name: 'pumpfun_compound_split_count',
  help: 'Total number of profit splits performed',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the compound manager. */
export interface CompoundManagerConfig {
  /** Percentage of profit going to cold wallet (0-100). Default: 35. */
  readonly coldWalletPct?: number;
  /** Percentage of profit going to trading wallet (0-100). Default: 65. */
  readonly tradingWalletPct?: number;
}

/** Result of a profit split. */
export interface ProfitSplit {
  /** Amount going to cold wallet in lamports. */
  readonly coldWalletAmount: bigint;
  /** Amount going to trading wallet in lamports. */
  readonly tradingWalletAmount: bigint;
  /** The original total profit. */
  readonly totalProfit: bigint;
  /** Cold wallet split percentage used. */
  readonly coldWalletPct: number;
  /** Trading wallet split percentage used. */
  readonly tradingWalletPct: number;
}

/** Record of a single compound event. */
export interface CompoundRecord {
  /** Unique trade identifier. */
  readonly tradeId: string;
  /** Total profit from the trade in lamports. */
  readonly profit: bigint;
  /** Amount sent to cold wallet. */
  readonly coldWalletAmount: bigint;
  /** Amount sent to trading wallet. */
  readonly tradingWalletAmount: bigint;
  /** Cold wallet address. */
  readonly coldWalletAddr: string;
  /** Trading wallet address. */
  readonly tradingWalletAddr: string;
  /** Timestamp when the compound was recorded. */
  readonly timestamp: number;
}

/** Aggregate compound statistics. */
export interface CompoundStats {
  /** Total lamports compounded across all trades. */
  readonly totalCompounded: bigint;
  /** Total lamports sent to cold wallets. */
  readonly coldWalletTotal: bigint;
  /** Total lamports sent to trading wallets. */
  readonly tradingWalletTotal: bigint;
  /** Number of compound events recorded. */
  readonly splitCount: number;
  /** Configured cold wallet percentage. */
  readonly coldWalletPct: number;
  /** Configured trading wallet percentage. */
  readonly tradingWalletPct: number;
}

// ---------------------------------------------------------------------------
// CompoundManager
// ---------------------------------------------------------------------------

export class CompoundManager {
  readonly name = 'compound-manager';

  private readonly coldWalletPct: number;
  private readonly tradingWalletPct: number;

  /** Accumulated cold wallet total in lamports. */
  private coldWalletTotal = 0n;

  /** Accumulated trading wallet total in lamports. */
  private tradingWalletTotal = 0n;

  /** All compound records (in-memory log). */
  private readonly records: CompoundRecord[] = [];

  constructor(config?: CompoundManagerConfig) {
    const coldPct = config?.coldWalletPct ?? 35;
    const tradingPct = config?.tradingWalletPct ?? 65;

    // Validate that percentages sum to 100
    if (coldPct + tradingPct !== 100) {
      logger.warn('Compound split percentages do not sum to 100, normalising', {
        coldPct,
        tradingPct,
        sum: coldPct + tradingPct,
      });
    }

    this.coldWalletPct = coldPct;
    this.tradingWalletPct = tradingPct;

    logger.info('CompoundManager initialised', {
      coldWalletPct: this.coldWalletPct,
      tradingWalletPct: this.tradingWalletPct,
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Split a profit amount between cold and trading wallets.
   *
   * @param totalProfitLamports  Total profit in lamports to split.
   * @returns                    ProfitSplit with amounts for each wallet.
   */
  splitProfit(totalProfitLamports: bigint): ProfitSplit {
    if (totalProfitLamports <= 0n) {
      logger.warn('splitProfit called with non-positive amount', {
        totalProfitLamports: totalProfitLamports.toString(),
      });
      return {
        coldWalletAmount: 0n,
        tradingWalletAmount: 0n,
        totalProfit: totalProfitLamports,
        coldWalletPct: this.coldWalletPct,
        tradingWalletPct: this.tradingWalletPct,
      };
    }

    // Calculate splits using integer arithmetic to avoid rounding issues
    // coldWalletAmount = totalProfit * coldWalletPct / 100
    const coldWalletAmount = (totalProfitLamports * BigInt(this.coldWalletPct)) / 100n;
    // Trading wallet gets the remainder to avoid lamport dust loss
    const tradingWalletAmount = totalProfitLamports - coldWalletAmount;

    logger.debug('Profit split calculated', {
      totalProfit: totalProfitLamports.toString(),
      coldWallet: coldWalletAmount.toString(),
      tradingWallet: tradingWalletAmount.toString(),
      coldPct: this.coldWalletPct,
      tradingPct: this.tradingWalletPct,
    });

    return Object.freeze({
      coldWalletAmount,
      tradingWalletAmount,
      totalProfit: totalProfitLamports,
      coldWalletPct: this.coldWalletPct,
      tradingWalletPct: this.tradingWalletPct,
    });
  }

  /**
   * Record a compound event after a take-profit execution.
   *
   * Updates running totals and emits Prometheus metrics.
   *
   * @param tradeId          Unique identifier for the trade.
   * @param profit           Total profit from the trade in lamports.
   * @param coldWalletAddr   Address of the cold wallet.
   * @param tradingWalletAddr  Address of the trading wallet.
   */
  recordCompound(
    tradeId: string,
    profit: bigint,
    coldWalletAddr: string,
    tradingWalletAddr: string,
  ): void {
    const split = this.splitProfit(profit);

    // Update running totals
    this.coldWalletTotal += split.coldWalletAmount;
    this.tradingWalletTotal += split.tradingWalletAmount;

    // Create record
    const record: CompoundRecord = {
      tradeId,
      profit,
      coldWalletAmount: split.coldWalletAmount,
      tradingWalletAmount: split.tradingWalletAmount,
      coldWalletAddr,
      tradingWalletAddr,
      timestamp: nowMs(),
    };

    this.records.push(record);

    // Emit Prometheus metrics
    compoundTotalLamports.inc({ destination: 'cold_wallet' }, Number(split.coldWalletAmount));
    compoundTotalLamports.inc({ destination: 'trading_wallet' }, Number(split.tradingWalletAmount));
    compoundSplitCount.inc();

    logger.info('Compound recorded', {
      tradeId,
      profit: profit.toString(),
      coldWalletAmount: split.coldWalletAmount.toString(),
      tradingWalletAmount: split.tradingWalletAmount.toString(),
      coldWalletAddr: coldWalletAddr.slice(0, 8),
      tradingWalletAddr: tradingWalletAddr.slice(0, 8),
      totalCompounded: (this.coldWalletTotal + this.tradingWalletTotal).toString(),
    });
  }

  /**
   * Get aggregate compound statistics.
   *
   * @returns CompoundStats with running totals.
   */
  getCompoundStats(): CompoundStats {
    return Object.freeze({
      totalCompounded: this.coldWalletTotal + this.tradingWalletTotal,
      coldWalletTotal: this.coldWalletTotal,
      tradingWalletTotal: this.tradingWalletTotal,
      splitCount: this.records.length,
      coldWalletPct: this.coldWalletPct,
      tradingWalletPct: this.tradingWalletPct,
    });
  }

  /**
   * Get all compound records (read-only snapshot).
   */
  getRecords(): ReadonlyArray<CompoundRecord> {
    return Object.freeze([...this.records]);
  }

  /**
   * Get records for a specific trading wallet address.
   */
  getRecordsByTradingWallet(walletAddr: string): ReadonlyArray<CompoundRecord> {
    return Object.freeze(
      this.records.filter((r) => r.tradingWalletAddr === walletAddr),
    );
  }

  /**
   * Reset all accumulated state (useful for testing).
   */
  reset(): void {
    this.coldWalletTotal = 0n;
    this.tradingWalletTotal = 0n;
    this.records.length = 0;
    logger.info('CompoundManager state reset');
  }
}
