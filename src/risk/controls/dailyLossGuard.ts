/**
 * Daily Loss Guard
 *
 * Tracks cumulative daily P&L and triggers the kill switch when
 * daily losses exceed the configured limit.
 *
 * LOCKED VALUES:
 *   - Daily kill limit: -$40
 *
 * Risk = capital preservation ONLY. No execution, no strategy logic.
 */

import { DEFAULT_DAILY_KILL_LIMIT_USD } from '../../core/constants/defaults.js';
import type { RiskStateRepository } from '../../storage/repositories/riskStateRepository.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('risk:dailyLossGuard');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Daily P&L state. */
export interface DailyPnlState {
  /** Cumulative realized P&L today in USD (negative = loss). */
  readonly dailyPnlUsd: number;
  /** Number of trades today. */
  readonly tradeCount: number;
  /** Number of stop losses today. */
  readonly stopLossCount: number;
  /** When the day started (midnight UTC ms). */
  readonly dayStartMs: number;
  /** Whether the kill limit has been breached. */
  readonly limitBreached: boolean;
}

/** Kill switch callback. */
export type DailyKillCallback = (state: DailyPnlState) => void;

/** Configuration. */
export interface DailyLossGuardConfig {
  /** Daily kill limit in USD (positive number). Default: 40 (LOCKED). */
  readonly dailyKillLimitUsd?: number;
  /** Optional risk state repository for persistence. */
  readonly riskStateRepo?: RiskStateRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMidnightUtcMs(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return midnight.getTime();
}

// ---------------------------------------------------------------------------
// DailyLossGuard
// ---------------------------------------------------------------------------

export class DailyLossGuard {
  private readonly killLimitUsd: number;
  private dailyPnlUsd = 0;
  private tradeCount = 0;
  private stopLossCount = 0;
  private dayStartMs: number;
  private limitBreached = false;
  private readonly onKillCallbacks: DailyKillCallback[] = [];
  private readonly riskStateRepo: RiskStateRepository | null;

  private static readonly STATE_KEY = 'daily_loss_guard';

  constructor(config?: DailyLossGuardConfig) {
    this.killLimitUsd = config?.dailyKillLimitUsd ?? DEFAULT_DAILY_KILL_LIMIT_USD;
    this.dayStartMs = getMidnightUtcMs();
    this.riskStateRepo = config?.riskStateRepo ?? null;
  }

  /**
   * Record a trade result.
   *
   * @param pnlUsd  Realized P&L for this trade in USD (negative = loss).
   * @param wasStopLoss  Whether the trade exited via stop loss.
   */
  recordTrade(pnlUsd: number, wasStopLoss: boolean): void {
    // Check for day rollover
    this.checkDayRollover();

    this.dailyPnlUsd += pnlUsd;
    this.tradeCount += 1;
    if (wasStopLoss) {
      this.stopLossCount += 1;
    }

    logger.info('Trade recorded', {
      pnlUsd: pnlUsd.toFixed(2),
      dailyPnlUsd: this.dailyPnlUsd.toFixed(2),
      tradeCount: this.tradeCount,
      killLimit: -this.killLimitUsd,
    });

    // Check kill limit
    if (!this.limitBreached && this.dailyPnlUsd <= -this.killLimitUsd) {
      this.limitBreached = true;
      logger.fatal('DAILY LOSS LIMIT BREACHED', {
        dailyPnlUsd: this.dailyPnlUsd.toFixed(2),
        killLimit: -this.killLimitUsd,
        tradeCount: this.tradeCount,
        stopLossCount: this.stopLossCount,
      });

      const state = this.getState();
      for (const cb of this.onKillCallbacks) {
        try {
          cb(state);
        } catch (err: unknown) {
          logger.error('Daily kill callback threw', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Persist state to DB (fire-and-forget)
    void this.saveToDb();
  }

  /**
   * Check if trading is allowed (daily limit not breached).
   */
  canTrade(): boolean {
    this.checkDayRollover();
    return !this.limitBreached;
  }

  /**
   * Get current daily P&L state.
   */
  getState(): DailyPnlState {
    this.checkDayRollover();
    return {
      dailyPnlUsd: this.dailyPnlUsd,
      tradeCount: this.tradeCount,
      stopLossCount: this.stopLossCount,
      dayStartMs: this.dayStartMs,
      limitBreached: this.limitBreached,
    };
  }

  /**
   * Register a callback for when the daily limit is breached.
   */
  onKill(callback: DailyKillCallback): void {
    this.onKillCallbacks.push(callback);
  }

  /**
   * Get remaining loss budget in USD.
   */
  getRemainingBudgetUsd(): number {
    this.checkDayRollover();
    return this.killLimitUsd + this.dailyPnlUsd;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private checkDayRollover(): void {
    const currentMidnight = getMidnightUtcMs();
    if (currentMidnight > this.dayStartMs) {
      // New day — reset counters
      logger.info('Day rollover — resetting daily P&L', {
        previousPnl: this.dailyPnlUsd.toFixed(2),
        previousTrades: this.tradeCount,
      });
      this.dailyPnlUsd = 0;
      this.tradeCount = 0;
      this.stopLossCount = 0;
      this.dayStartMs = currentMidnight;
      this.limitBreached = false;
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Restore state from DB. Call once at startup after DB is connected.
   * If no saved state exists, or the saved day is before today, resets.
   */
  async restore(): Promise<void> {
    if (this.riskStateRepo === null) return;

    try {
      const saved = await this.riskStateRepo.loadState<{
        dailyPnlUsd: number;
        tradeCount: number;
        stopLossCount: number;
        dayStartMs: number;
        limitBreached: boolean;
      }>(DailyLossGuard.STATE_KEY);

      if (saved === null) {
        logger.info('No saved daily loss state found — starting fresh');
        return;
      }

      const currentMidnight = getMidnightUtcMs();
      if (saved.dayStartMs < currentMidnight) {
        logger.info('Saved daily loss state is from a previous day — resetting', {
          savedDayStartMs: saved.dayStartMs,
          currentMidnight,
        });
        return;
      }

      this.dailyPnlUsd = saved.dailyPnlUsd;
      this.tradeCount = saved.tradeCount;
      this.stopLossCount = saved.stopLossCount;
      this.dayStartMs = saved.dayStartMs;
      this.limitBreached = saved.limitBreached;

      logger.info('Daily loss state restored from DB', {
        dailyPnlUsd: this.dailyPnlUsd.toFixed(2),
        tradeCount: this.tradeCount,
        stopLossCount: this.stopLossCount,
        limitBreached: this.limitBreached,
      });
    } catch (err: unknown) {
      logger.warn('Failed to restore daily loss state — starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private saveToDb(): void {
    if (this.riskStateRepo === null) return;

    void this.riskStateRepo.saveState(DailyLossGuard.STATE_KEY, {
      dailyPnlUsd: this.dailyPnlUsd,
      tradeCount: this.tradeCount,
      stopLossCount: this.stopLossCount,
      dayStartMs: this.dayStartMs,
      limitBreached: this.limitBreached,
    });
  }
}
