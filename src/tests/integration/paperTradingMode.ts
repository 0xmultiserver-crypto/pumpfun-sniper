/**
 * Paper Trading Mode
 *
 * Real data ingestion + mock execution. Allows testing the full
 * pipeline with live market data without risking real funds.
 *
 * Design:
 *   - Real: WebSocket events, RPC data fetching, signal detection
 *   - Mock: Transaction building, signing, sending, confirmation
 *   - Tracks: simulated positions, P&L, trade history
 *
 * NOTE: This file defines the paper trading infrastructure.
 * Actually RUNNING it requires VPS with WebSocket + RPC access.
 *
 * App layer = orchestration ONLY. No business logic (rule.md).
 */

import type { MintAddress } from '../../core/types/token.js';
import type { ExitReason } from '../../core/types/strategy.js';
import type {
  StrategyDataProvider,
  StrategyExecutionDelegate,
  BuyParams,
  BuyResult,
  SellParams,
  SellResult,
} from '../../strategies/filteredSniper/filteredSniperStrategy.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('paper:tradingMode');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Paper trade record */
export interface PaperTradeRecord {
  readonly id: string;
  readonly mint: MintAddress;
  readonly side: 'BUY' | 'SELL';
  readonly amountUsd: number;
  readonly simulatedPriceLamports: bigint;
  readonly timestamp: number;
  readonly exitReason: ExitReason | null;
}

/** Paper position */
export interface PaperPosition {
  readonly tradeId: string;
  readonly mint: MintAddress;
  readonly entryPriceLamports: bigint;
  readonly entryTimestamp: number;
  readonly amountUsd: number;
  exitPriceLamports: bigint | null;
  exitTimestamp: number | null;
  exitReason: ExitReason | null;
  pnlPercent: number | null;
  closed: boolean;
}

/** Paper trading session stats */
export interface PaperTradingStats {
  readonly totalTrades: number;
  readonly openPositions: number;
  readonly closedPositions: number;
  readonly totalPnlPercent: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly winRate: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Paper Execution Delegate
// ---------------------------------------------------------------------------

/**
 * Paper execution delegate that simulates trades without sending
 * real transactions. Tracks all simulated positions and P&L.
 */
export class PaperExecutionDelegate implements StrategyExecutionDelegate {
  private readonly positions: Map<string, PaperPosition> = new Map();
  private readonly tradeHistory: PaperTradeRecord[] = [];
  private tradeCounter = 0;
  private readonly startedAt: number;

  /** Current simulated price provider (injected from real data) */
  private priceProvider: ((mint: MintAddress) => bigint | null) | null = null;

  constructor() {
    this.startedAt = Date.now();
    logger.info('Paper execution delegate initialized');
  }

  /**
   * Set the price provider function.
   * In paper mode, this is fed by real RPC data.
   */
  setPriceProvider(provider: (mint: MintAddress) => bigint | null): void {
    this.priceProvider = provider;
  }

  /**
   * Simulate a buy execution.
   * No real transaction — just record the position.
   */
  async executeBuy(params: BuyParams): Promise<BuyResult> {
    this.tradeCounter++;
    const tradeId = `paper-${this.tradeCounter.toString().padStart(6, '0')}`;
    const timestamp = Date.now();

    // Get current price from provider
    const price = this.priceProvider?.(params.mint) ?? 0n;

    const position: PaperPosition = {
      tradeId,
      mint: params.mint,
      entryPriceLamports: price,
      entryTimestamp: timestamp,
      amountUsd: params.positionSizeUsd,
      exitPriceLamports: null,
      exitTimestamp: null,
      exitReason: null,
      pnlPercent: null,
      closed: false,
    };

    this.positions.set(tradeId, position);

    this.tradeHistory.push({
      id: tradeId,
      mint: params.mint,
      side: 'BUY',
      amountUsd: params.positionSizeUsd,
      simulatedPriceLamports: price,
      timestamp,
      exitReason: null,
    });

    logger.info('PAPER BUY executed', {
      tradeId,
      mint: params.mint,
      price: price.toString(),
      amountUsd: params.positionSizeUsd,
    });

    return {
      success: true,
      tradeId,
      signature: `paper-sig-${tradeId}`,
      error: null,
    };
  }

  /**
   * Simulate a sell execution.
   * No real transaction — just close the position and record P&L.
   */
  async executeSell(params: SellParams): Promise<SellResult> {
    const position = this.positions.get(params.tradeId);
    if (position === undefined) {
      logger.error('Paper sell: position not found', { tradeId: params.tradeId });
      return { success: false, signature: null, error: 'Position not found' };
    }

    const exitTimestamp = Date.now();
    const exitPrice = this.priceProvider?.(params.mint) ?? position.entryPriceLamports;

    // Calculate P&L using BigInt-safe math
    let pnlPercent = 0;
    if (position.entryPriceLamports > 0n) {
      const pnlBps = ((exitPrice - position.entryPriceLamports) * 10_000n) / position.entryPriceLamports;
      pnlPercent = Number(pnlBps) / 100;
    }

    // Update position
    position.exitPriceLamports = exitPrice;
    position.exitTimestamp = exitTimestamp;
    position.exitReason = params.reason;
    position.pnlPercent = pnlPercent;
    position.closed = true;

    this.tradeHistory.push({
      id: params.tradeId,
      mint: params.mint,
      side: 'SELL',
      amountUsd: position.amountUsd,
      simulatedPriceLamports: exitPrice,
      timestamp: exitTimestamp,
      exitReason: params.reason,
    });

    logger.info('PAPER SELL executed', {
      tradeId: params.tradeId,
      mint: params.mint,
      exitPrice: exitPrice.toString(),
      entryPrice: position.entryPriceLamports.toString(),
      pnlPercent: pnlPercent.toFixed(2),
      exitReason: params.reason,
    });

    return {
      success: true,
      signature: `paper-sig-sell-${params.tradeId}`,
      error: null,
    };
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  /** Get all positions (open + closed). */
  getPositions(): readonly PaperPosition[] {
    return [...this.positions.values()];
  }

  /** Get open positions only. */
  getOpenPositions(): readonly PaperPosition[] {
    return [...this.positions.values()].filter((p) => !p.closed);
  }

  /** Get closed positions only. */
  getClosedPositions(): readonly PaperPosition[] {
    return [...this.positions.values()].filter((p) => p.closed);
  }

  /** Get trade history. */
  getTradeHistory(): readonly PaperTradeRecord[] {
    return [...this.tradeHistory];
  }

  /** Get session stats. */
  getStats(): PaperTradingStats {
    const positions = [...this.positions.values()];
    const closed = positions.filter((p) => p.closed);
    const open = positions.filter((p) => !p.closed);
    const wins = closed.filter((p) => (p.pnlPercent ?? 0) > 0);
    const losses = closed.filter((p) => (p.pnlPercent ?? 0) < 0);
    const totalPnl = closed.reduce((sum, p) => sum + (p.pnlPercent ?? 0), 0);

    return {
      totalTrades: this.tradeHistory.length,
      openPositions: open.length,
      closedPositions: closed.length,
      totalPnlPercent: totalPnl,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /** Print a summary to the logger. */
  logSummary(): void {
    const stats = this.getStats();
    logger.info('=== PAPER TRADING SUMMARY ===', {
      totalTrades: stats.totalTrades,
      openPositions: stats.openPositions,
      closedPositions: stats.closedPositions,
      totalPnlPercent: stats.totalPnlPercent.toFixed(2),
      winRate: stats.winRate.toFixed(1),
      uptimeMinutes: (stats.uptimeMs / 60_000).toFixed(1),
    });

    for (const pos of this.getClosedPositions()) {
      logger.info('  Trade:', {
        tradeId: pos.tradeId,
        mint: pos.mint,
        pnl: `${(pos.pnlPercent ?? 0).toFixed(2)}%`,
        reason: pos.exitReason,
      });
    }
  }
}
