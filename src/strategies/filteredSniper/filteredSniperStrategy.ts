/**
 * Filtered Sniper Strategy
 *
 * The main strategy class that orchestrates:
 *   1. Entry evaluation (all 10 checks)
 *   2. Position monitoring
 *   3. Exit evaluation (TP/SL/timeout)
 *
 * This is PURE BUSINESS LOGIC. It does NOT:
 *   - Make RPC calls
 *   - Query databases
 *   - Decode protocol data
 *   - Build transactions
 *
 * All external data is provided via interfaces (dependency injection).
 * All execution is delegated to the execution layer.
 *
 * Strategy = business logic ONLY.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { Signal } from '../../core/types/signal.js';
import type { EntryCheckData, EntryDecisionResult } from './entryDecision.js';
import type { PositionData, ExitReason } from './exitDecision.js';
import { evaluateEntry } from './entryDecision.js';
import { evaluateExit } from './exitDecision.js';
import {
  ENTRY_VENUE,
  MAX_CONCURRENT_POSITIONS,
  POSITION_SIZE_USD,
  SLIPPAGE_BPS,
  MOMENTUM_MIN_VOLUME_LAMPORTS,
} from './filteredSniperRules.js';
import type { IStrategy } from '../../core/interfaces/strategy.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import type { DynamicPositionSizer } from './positionSizer.js';

const logger = createLogger('strategy:filteredSniper');

const EXPECTED_BUY_BLOCK_PATTERNS = [
  'cooldown active',
  'kill switch',
  'daily loss limit',
  'throttled',
  'max exposure',
] as const;

export function isExpectedBuyBlock(error: string | null): boolean {
  if (error === null) {
    return false;
  }

  const normalized = error.toLowerCase();
  return EXPECTED_BUY_BLOCK_PATTERNS.some((pattern) => normalized.includes(pattern));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data provider interface — strategy asks for data, doesn't fetch it. */
export interface StrategyDataProvider {
  /** Get entry check data for a detector signal. */
  getEntryCheckData(signal: Signal): Promise<EntryCheckData>;
  /** Get current position data for exit evaluation. */
  getPositionData(tradeId: string): Promise<PositionData | null>;
  /** Get current active position count. */
  getActivePositionCount(): number;
}

/** Execution delegate — strategy tells what to do, doesn't do it. */
export interface StrategyExecutionDelegate {
  /** Execute a buy order. */
  executeBuy(params: BuyParams): Promise<BuyResult>;
  /** Execute a sell order. */
  executeSell(params: SellParams): Promise<SellResult>;
}

/** Buy parameters (strategy → execution layer). */
export interface BuyParams {
  readonly mint: MintAddress;
  readonly venue: typeof ENTRY_VENUE;
  readonly positionSizeUsd: number;
  readonly slippageBps: number;
  readonly entryDecision: EntryDecisionResult;
}

/** Buy result (execution layer → strategy). */
export interface BuyResult {
  readonly success: boolean;
  readonly tradeId: string | null;
  readonly signature: string | null;
  readonly error: string | null;
}

/** Sell parameters (strategy → execution layer). */
export interface SellParams {
  readonly tradeId: string;
  readonly mint: MintAddress;
  readonly reason: ExitReason;
  readonly slippageBps: number;
}

/** Sell result (execution layer → strategy). */
export interface SellResult {
  readonly success: boolean;
  readonly signature: string | null;
  readonly error: string | null;
}

/** Strategy state. */
type StrategyState = 'IDLE' | 'RUNNING' | 'STOPPED';

// ---------------------------------------------------------------------------
// FilteredSniperStrategy
// ---------------------------------------------------------------------------

export class FilteredSniperStrategy implements IStrategy {
  private readonly dataProvider: StrategyDataProvider;
  private readonly executionDelegate: StrategyExecutionDelegate;
  private readonly positionSizer: DynamicPositionSizer | null;
  private state: StrategyState = 'IDLE';

  /** Active trade IDs being monitored for exit. */
  private readonly monitoredTrades = new Set<string>();

  /** Trade IDs with an exit execution currently in-flight. */
  private readonly exitingTrades = new Set<string>();

  /** Exit monitoring interval handle. */
  private monitorIntervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Exit monitor poll interval in ms. */
  private readonly monitorPollMs: number;

  constructor(
    dataProvider: StrategyDataProvider,
    executionDelegate: StrategyExecutionDelegate,
    positionSizer?: DynamicPositionSizer,
    monitorPollMs: number = 1_000,
  ) {
    this.dataProvider = dataProvider;
    this.executionDelegate = executionDelegate;
    this.positionSizer = positionSizer ?? null;
    this.monitorPollMs = monitorPollMs;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the strategy. Begins exit monitoring loop.
   */
  start(): void {
    if (this.state === 'RUNNING') {
      logger.warn('Strategy already running');
      return;
    }

    this.state = 'RUNNING';
    this.startExitMonitor();
    logger.info('Filtered sniper strategy started');
  }

  /**
   * Stop the strategy. Stops exit monitoring.
   */
  stop(): void {
    this.state = 'STOPPED';
    this.stopExitMonitor();
    logger.info('Filtered sniper strategy stopped');
  }

  /**
   * Get current strategy state.
   */
  getState(): StrategyState {
    return this.state;
  }

  /**
   * Add an already-confirmed/open trade to exit monitoring.
   * Used for startup DB recovery after a bot restart.
   */
  monitorTrade(tradeId: string): void {
    this.monitoredTrades.add(tradeId);
    logger.info('Trade added to exit monitor', { tradeId });
  }

  // -------------------------------------------------------------------------
  // Entry Flow
  // -------------------------------------------------------------------------

  /**
   * Handle a new token signal (launch detected + momentum).
   *
   * Flow:
   *   1. Check if strategy is running
   *   2. Check if we have capacity (max concurrent positions)
   *   3. Fetch entry check data from provider
   *   4. Evaluate all 9 entry checks
   *   5. If ALL pass → execute buy
   *   6. If ANY fail → reject (log reason)
   */
  async onSignal(signal: Signal): Promise<EntryDecisionResult | null> {
    const mint = signal.mint;

    logger.info('onSignal called', { mint, signalType: signal.type, state: this.state });

    // Guard: strategy must be running
    if (this.state !== 'RUNNING') {
      logger.info('Signal ignored: strategy not running', { mint, signalType: signal.type, state: this.state });
      return null;
    }

    // Guard: BUY entries are momentum-triggered only. Launch signals seed
    // provenance/history; migration signals are exit/liquidity lifecycle data.
    if (signal.type !== 'MOMENTUM') {
      logger.debug('Signal ignored: not a momentum entry signal', {
        mint,
        signalType: signal.type,
      });
      return null;
    }

    // Guard: check capacity
    const activeCount = this.dataProvider.getActivePositionCount();
    if (activeCount >= MAX_CONCURRENT_POSITIONS) {
      logger.debug('Signal ignored: max concurrent positions reached', {
        mint,
        activeCount,
        max: MAX_CONCURRENT_POSITIONS,
      });
      return null;
    }

    // Fetch entry check data
    const checkData = await this.dataProvider.getEntryCheckData(signal);

    // Evaluate all 10 checks
    const decision = evaluateEntry(checkData);

    if (!decision.allowed) {
      logger.info('Token rejected by entry checks', {
        mint,
        passedCount: decision.passedCount,
        failedCount: decision.failedCount,
        firstFailure: decision.firstFailure,
      });
      return decision;
    }

    // ALL 10 CHECKS PASSED — execute buy
    // Calculate dynamic position size if sizer available
    let positionSizeUsd: number = POSITION_SIZE_USD;
    if (this.positionSizer !== null) {
      positionSizeUsd = this.positionSizer.calculateSize({
        momentumVolumeLamports: checkData.volumeLamports,
        momentumMinVolumeLamports: MOMENTUM_MIN_VOLUME_LAMPORTS,
        creatorScore: checkData.creatorScore ?? null,
        secondsSinceLaunch: checkData.secondsSinceLaunch ?? 0,
        marketCapUsd: checkData.marketCapUsd ?? null,
      });
      const mcapTier = this.positionSizer.getTier(checkData.marketCapUsd ?? null);
      logger.info('Dynamic position size calculated', {
        mint,
        positionSizeUsd,
        marketCapTier: mcapTier,
        marketCapUsd: checkData.marketCapUsd,
      });
    }

    logger.info('ALL 10 entry checks passed — executing buy', {
      mint,
      passedCount: decision.passedCount,
      positionSizeUsd,
    });

    const buyResult = await this.executionDelegate.executeBuy({
      mint,
      venue: ENTRY_VENUE,
      positionSizeUsd,
      slippageBps: SLIPPAGE_BPS,
      entryDecision: decision,
    });

    if (buyResult.success && buyResult.tradeId !== null) {
      this.monitoredTrades.add(buyResult.tradeId);
      logger.info('Buy executed, monitoring for exit', {
        mint,
        tradeId: buyResult.tradeId,
        signature: buyResult.signature,
      });
    } else if (isExpectedBuyBlock(buyResult.error)) {
      logger.warn('Buy skipped by risk guard', {
        mint,
        error: buyResult.error,
      });
    } else {
      logger.error('Buy execution failed', {
        mint,
        error: buyResult.error,
      });
    }

    return decision;
  }

  // -------------------------------------------------------------------------
  // Exit Flow
  // -------------------------------------------------------------------------

  /**
   * Evaluate exit for a single trade.
   */
  private async evaluateTradeExit(tradeId: string): Promise<void> {
    if (this.exitingTrades.has(tradeId)) {
      logger.debug('Exit evaluation skipped: sell already in-flight', { tradeId });
      return;
    }

    const positionData = await this.dataProvider.getPositionData(tradeId);
    if (positionData === null) {
      // Trade no longer exists — remove from monitoring
      this.monitoredTrades.delete(tradeId);
      return;
    }

    const exitDecision = evaluateExit(positionData);

    if (exitDecision.shouldExit && exitDecision.reason !== null) {
      logger.info('Exit triggered', {
        tradeId,
        mint: positionData.mint,
        reason: exitDecision.reason,
        pnlPercent: exitDecision.pnlPercent.toFixed(2),
        elapsedMs: exitDecision.elapsedMs,
      });

      // Remove from monitoring BEFORE executing to prevent double-exit.
      // Also mark in-flight because setInterval callbacks may overlap when an
      // earlier sell is still waiting for chain confirmation.
      this.monitoredTrades.delete(tradeId);
      this.exitingTrades.add(tradeId);

      let sellResult;
      try {
        sellResult = await this.executionDelegate.executeSell({
          tradeId,
          mint: positionData.mint,
          reason: exitDecision.reason,
          slippageBps: SLIPPAGE_BPS,
        });
      } finally {
        this.exitingTrades.delete(tradeId);
      }

      if (sellResult.success) {
        logger.info('Exit executed successfully', {
          tradeId,
          reason: exitDecision.reason,
          signature: sellResult.signature,
        });
      } else {
        logger.error('Exit execution failed — re-adding to monitor', {
          tradeId,
          error: sellResult.error,
        });
        // Re-add for retry on next poll
        this.monitoredTrades.add(tradeId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Exit Monitor
  // -------------------------------------------------------------------------

  private startExitMonitor(): void {
    this.monitorIntervalHandle = setInterval(async () => {
      if (this.state !== 'RUNNING') return;
      if (this.monitoredTrades.size === 0) return;

      // Evaluate each trade sequentially (bounded by max concurrent positions)
      for (const tradeId of [...this.monitoredTrades]) {
        if (!this.monitoredTrades.has(tradeId) || this.exitingTrades.has(tradeId)) {
          continue;
        }
        try {
          await this.evaluateTradeExit(tradeId);
        } catch (err: unknown) {
          logger.error('Exit monitor error', {
            tradeId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, this.monitorPollMs);
  }

  private stopExitMonitor(): void {
    if (this.monitorIntervalHandle !== null) {
      clearInterval(this.monitorIntervalHandle);
      this.monitorIntervalHandle = null;
    }
  }
}
