/**
 * Filtered Sniper Strategy
 *
 * The main strategy class that orchestrates:
 *   1. Entry evaluation (all 13 checks)
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
  SCALE_OUT_TIERS,
} from './filteredSniperRules.js';
import type { IStrategy } from '../../core/interfaces/strategy.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';
import type { DynamicPositionSizer } from './positionSizer.js';
import { DEFAULT_EXIT_MONITOR_POLL_MS } from '../../core/constants/defaults/infrastructure.js';

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
  /** Check if a token is blacklisted (e.g., after stop-loss exit). */
  isTokenBlacklisted(mint: string): boolean;
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
  /** Percentage of current token balance to sell (1-100). Default: 100 (full sell). */
  readonly sellPct?: number;
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

  /** Track completed scale-out tiers per trade (in-memory). */
  private readonly completedScaleOutTiers = new Map<string, Set<number>>();

  /** Active mints being held (prevents double-buy on restart or re-entry). */
  private readonly activeMints = new Set<string>();
  /** Number of buys currently in-flight (between capacity check and registration). */
  private pendingBuyCount = 0;
  /** Track consecutive sell failures per trade to prevent infinite retry. */
  private readonly sellFailureCounts = new Map<string, number>();
  /** Track stuck positions — skip N cycles before retrying sell. */
  private readonly stuckPositionSkipCounts = new Map<string, number>();
  private static readonly MAX_SELL_FAILURES = 5;
  /** After MAX_SELL_FAILURES, wait this many cycles before retrying (exponential backoff). */
  private static readonly STUCK_POSITION_BACKOFF_MULTIPLIER = 3;

  /**
   * Signal queue for when all position slots are full.
   * Instead of dropping signals, we queue them and process when a slot opens.
   * This prevents missing good tokens while holding existing positions.
   */
  private readonly signalQueue = new Map<string, { signal: Signal; queuedAt: number }>();
  private static readonly SIGNAL_QUEUE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly SIGNAL_QUEUE_MAX_SIZE = 10;

  /** Exit monitoring interval handle. */
  private monitorIntervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Exit monitor poll interval in ms. */
  private readonly monitorPollMs: number;

  constructor(
    dataProvider: StrategyDataProvider,
    executionDelegate: StrategyExecutionDelegate,
    positionSizer?: DynamicPositionSizer,
    monitorPollMs: number = DEFAULT_EXIT_MONITOR_POLL_MS,
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
  monitorTrade(tradeId: string, mint?: string): void {
    this.monitoredTrades.add(tradeId);
    if (mint) {
      this.activeMints.add(mint);
    }
    logger.info('Trade added to exit monitor', { tradeId, mint });
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

    logger.debug('onSignal called', { mint, signalType: signal.type, state: this.state });

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

    // Guard: check capacity (includes in-flight buys to prevent race condition)
    const activeCount = this.dataProvider.getActivePositionCount();
    const totalCount = activeCount + this.pendingBuyCount;
    if (totalCount >= MAX_CONCURRENT_POSITIONS) {
      // Instead of dropping the signal, queue it for when a slot opens.
      // This prevents missing good tokens while holding existing positions.
      if (!this.signalQueue.has(mint) && this.signalQueue.size < FilteredSniperStrategy.SIGNAL_QUEUE_MAX_SIZE) {
        this.signalQueue.set(mint, { signal, queuedAt: nowMs() });
        logger.info('Signal queued (slots full)', {
          mint,
          activeCount,
          pendingBuys: this.pendingBuyCount,
          max: MAX_CONCURRENT_POSITIONS,
          queueSize: this.signalQueue.size,
        });
      }
      return null;
    }

    // Guard: check if we already hold this mint (prevents double-buy on restart)
    if (this.activeMints.has(mint)) {
      logger.debug('Signal ignored: already holding this mint', { mint });
      return null;
    }

    // Guard: check if token is blacklisted (e.g., after stop-loss exit)
    if (this.dataProvider.isTokenBlacklisted(mint)) {
      logger.info('Signal ignored: token is blacklisted', { mint });
      return { allowed: false, passedCount: 0, failedCount: 1, firstFailure: 'Token blacklisted (stop-loss)', checks: [] };
    }

    // Reserve slot — increment BEFORE any async to prevent race condition
    // where multiple signals pass capacity check before any buy registers.
    this.pendingBuyCount += 1;

    try {
      const checkData = await this.dataProvider.getEntryCheckData(signal);

      // Evaluate all 13 checks
      const decision = evaluateEntry(checkData);

      if (!decision.allowed) {
        logger.info('Token rejected by entry checks', {
          mint,
          passedCount: decision.passedCount,
          failedCount: decision.failedCount,
          firstFailure: decision.firstFailure,
        });
        this.pendingBuyCount -= 1;
        return decision;
      }

      // ALL 16 CHECKS PASSED — execute buy
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

      logger.info('ALL 16 entry checks passed — executing buy', {
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
        this.activeMints.add(mint);
        this.pendingBuyCount -= 1; // Position now tracked by registry (activeCount)
        logger.info('Buy executed, monitoring for exit', {
          mint,
          tradeId: buyResult.tradeId,
          signature: buyResult.signature,
        });
      } else {
        // Buy failed — release reserved slot
        this.pendingBuyCount -= 1;
        if (isExpectedBuyBlock(buyResult.error)) {
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
      }

      return decision;
    } catch (err: unknown) {
      // Unexpected error — release reserved slot
      this.pendingBuyCount -= 1;
      throw err;
    }
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
      this.completedScaleOutTiers.delete(tradeId);
      // Mint cleanup: we don't know the mint here, but it will be cleaned
      // when the position exit is detected below
      return;
    }

    // Merge strategy-level scale-out tracking into position data
    const completedTiers = this.completedScaleOutTiers.get(tradeId);
    const mergedPositionData = completedTiers && completedTiers.size > 0
      ? { ...positionData, scaleOutTiersCompleted: [...completedTiers] }
      : positionData;

    const exitDecision = evaluateExit(mergedPositionData);

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
          sellPct: exitDecision.sellPct,
        });
      } finally {
        this.exitingTrades.delete(tradeId);
      }

      if (sellResult.success) {
        // For SCALE_OUT: record completed tier and re-add to monitoring
        if (exitDecision.reason === 'SCALE_OUT') {
          // Record which tier was just sold so evaluateExit skips it next poll
          const tierIndex = SCALE_OUT_TIERS.findIndex((t: { sellPct: number }) => t.sellPct === exitDecision.sellPct);
          if (tierIndex >= 0) {
            const completed = this.completedScaleOutTiers.get(tradeId) ?? new Set<number>();
            completed.add(tierIndex);
            this.completedScaleOutTiers.set(tradeId, completed);
          }
          this.monitoredTrades.add(tradeId);
          logger.info('Scale-out partial sell complete, re-monitoring for next tier', {
            tradeId,
            sellPct: exitDecision.sellPct,
            tierIndex,
          });
        } else {
          // Full exit — remove mint from active tracking
          this.activeMints.delete(positionData.mint);
          this.completedScaleOutTiers.delete(tradeId);
          this.sellFailureCounts.delete(tradeId);
          logger.info('Exit executed successfully', {
            tradeId,
            reason: exitDecision.reason,
            signature: sellResult.signature,
          });
        }
      } else {
        const failCount = (this.sellFailureCounts.get(tradeId) ?? 0) + 1;
        this.sellFailureCounts.set(tradeId, failCount);

        if (failCount >= FilteredSniperStrategy.MAX_SELL_FAILURES) {
          // Don't give up! Keep position in monitoring with exponential backoff.
          // Token is still in wallet — must keep trying to sell.
          const backoffCycles = Math.min(
            failCount * FilteredSniperStrategy.STUCK_POSITION_BACKOFF_MULTIPLIER,
            30, // max 30 cycles backoff
          );
          this.stuckPositionSkipCounts.set(tradeId, backoffCycles);
          this.monitoredTrades.add(tradeId);
          logger.warn('SELL FAILED — stuck position, will retry with backoff', {
            tradeId,
            mint: positionData.mint,
            consecutiveFailures: failCount,
            backoffCycles,
            lastError: sellResult.error,
          });
        } else {
          logger.error('Exit execution failed — re-adding to monitor', {
            tradeId,
            error: sellResult.error,
            consecutiveFailures: failCount,
            maxFailures: FilteredSniperStrategy.MAX_SELL_FAILURES,
          });
          this.monitoredTrades.add(tradeId);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Exit Monitor
  // -------------------------------------------------------------------------

  private startExitMonitor(): void {
    this.monitorIntervalHandle = setInterval(async () => {
      if (this.state !== 'RUNNING') return;

      // Process queued signals if a slot is available
      await this.processSignalQueue();

      if (this.monitoredTrades.size === 0) return;

      // Evaluate each trade sequentially (bounded by max concurrent positions)
      for (const tradeId of [...this.monitoredTrades]) {
        if (!this.monitoredTrades.has(tradeId) || this.exitingTrades.has(tradeId)) {
          continue;
        }

        // Stuck position backoff — skip N cycles before retrying sell
        const skipCount = this.stuckPositionSkipCounts.get(tradeId);
        if (skipCount !== undefined && skipCount > 0) {
          this.stuckPositionSkipCounts.set(tradeId, skipCount - 1);
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

  /**
   * Process queued signals when a position slot opens.
   * Evicts expired signals, then tries to buy the oldest queued signal.
   */
  private async processSignalQueue(): Promise<void> {
    if (this.signalQueue.size === 0) return;

    const activeCount = this.dataProvider.getActivePositionCount();
    if (activeCount + this.pendingBuyCount >= MAX_CONCURRENT_POSITIONS) return;

    const now = nowMs();

    // Evict expired signals
    for (const [mint, entry] of this.signalQueue) {
      if (now - entry.queuedAt > FilteredSniperStrategy.SIGNAL_QUEUE_TTL_MS) {
        this.signalQueue.delete(mint);
        logger.debug('Queued signal expired', { mint, ageMs: now - entry.queuedAt });
      }
    }

    if (this.signalQueue.size === 0) return;

    // Process the oldest signal (FIFO)
    const oldest = [...this.signalQueue.entries()]
      .sort((a, b) => a[1].queuedAt - b[1].queuedAt)[0];

    if (!oldest) return;

    const [mint, { signal }] = oldest;
    this.signalQueue.delete(mint);

    logger.info('Processing queued signal (slot now available)', {
      mint,
      signalType: signal.type,
      queueSize: this.signalQueue.size,
    });

    // Re-evaluate the signal through the normal flow
    try {
      await this.onSignal(signal);
    } catch (err: unknown) {
      logger.error('Failed to process queued signal', {
        mint,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private stopExitMonitor(): void {
    if (this.monitorIntervalHandle !== null) {
      clearInterval(this.monitorIntervalHandle);
      this.monitorIntervalHandle = null;
    }
  }
}
