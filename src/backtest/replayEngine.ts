/**
 * Replay Engine — replays recorded events through the strategy logic with parameter overrides.
 *
 * Simulates buys/sells using the same MomentumDetector sliding-window approach
 * but with configurable parameters. Records all simulated trades with
 * entry/exit prices, timestamps, and PnL.
 */

import type { StoredBacktestEvent } from './eventRecorder.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('backtest:replayEngine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayParameters {
  /** Momentum window in seconds. */
  readonly windowSeconds: number;
  /** Minimum buy count in window to trigger entry. */
  readonly minBuyCount: number;
  /** Position size in USD. */
  readonly positionSizeUsd: number;
  /** Stop loss percentage (positive, e.g. 50 = -50%). */
  readonly stopLossPct: number;
  /** Take profit percentage (e.g. 500 = +500%). */
  readonly takeProfitPct: number;
}

export interface SimulatedTrade {
  readonly mint: string;
  readonly entryTimestamp: number;
  readonly exitTimestamp: number;
  readonly entryPriceSol: number;
  readonly exitPriceSol: number;
  readonly entrySlot: number;
  readonly exitSlot: number;
  readonly exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIMEOUT';
  readonly pnlSol: number;
  readonly pnlUsd: number;
  readonly pnlPercent: number;
  readonly positionSizeUsd: number;
  readonly durationMs: number;
}

export interface ReplayResult {
  readonly trades: readonly SimulatedTrade[];
  readonly eventsProcessed: number;
  readonly momentumSignals: number;
  readonly parameters: ReplayParameters;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_REPLAY_PARAMETERS: Readonly<ReplayParameters> = {
  windowSeconds: 15,
  minBuyCount: 7,
  positionSizeUsd: 1,
  stopLossPct: 50,
  takeProfitPct: 500,
} as const;

const TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// ---------------------------------------------------------------------------
// Internal types for tracking
// ---------------------------------------------------------------------------

interface BuyRecord {
  readonly timestamp: number;
  readonly solAmount: number;
  readonly slot: number;
}

interface OpenPosition {
  readonly mint: string;
  readonly entryTimestamp: number;
  readonly entrySlot: number;
  /** Simulated entry price: average solAmount of triggering buys. */
  readonly entryPriceSol: number;
  readonly positionSizeUsd: number;
  /** Highest seen solAmount (for trailing stop, simplified). */
  highestPriceSol: number;
}

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

export class ReplayEngine {
  private readonly params: ReplayParameters;

  constructor(params?: Partial<ReplayParameters>) {
    this.params = { ...DEFAULT_REPLAY_PARAMETERS, ...params };
  }

  /**
   * Replay events and return simulated trades.
   *
   * Events MUST be sorted by timestamp ascending.
   */
  replay(events: readonly StoredBacktestEvent[]): ReplayResult {
    const windowMs = this.params.windowSeconds * 1000;
    const buyHistory = new Map<string, BuyRecord[]>();
    const openPositions = new Map<string, OpenPosition>();
    const trades: SimulatedTrade[] = [];
    let momentumSignals = 0;

    // SOL/USD price (simplified: use a fixed fallback for backtest)
    const solPriceUsd = 150;

    for (const event of events) {
      const timestamp = event.timestamp;

      // --- Check timeouts for open positions ---
      for (const [mint, pos] of openPositions) {
        if (timestamp - pos.entryTimestamp > TIMEOUT_MS) {
          // Close at entry price (no price change for timeout — conservative)
          const exitPriceSol = pos.entryPriceSol;
          const trade = this.closePosition(
            pos,
            mint,
            exitPriceSol,
            timestamp,
            event.slot ?? 0,
            'TIMEOUT',
            solPriceUsd,
          );
          trades.push(trade);
          openPositions.delete(mint);
        }
      }

      // --- Process trade events ---
      if (event.eventType === 'trade') {
        const mint = event.mint;
        if (mint === null || mint === '') continue;

        const isBuy = (event.data['isBuy'] as boolean) ?? true;
        if (!isBuy) {
          // Sell event — check if we have an open position to evaluate for exit
          const openPos = openPositions.get(mint);
          if (openPos !== undefined) {
            const currentPriceSol =
              typeof event.data['solAmount'] === 'number'
                ? (event.data['solAmount'] as number)
                : parseFloat((event.data['solAmount'] as string) ?? '0');
            if (currentPriceSol > 0) {
              // Update highest price
              if (currentPriceSol > openPos.highestPriceSol) {
                openPos.highestPriceSol = currentPriceSol;
              }
              // Check stop loss
              const pnlPct =
                ((currentPriceSol - openPos.entryPriceSol) / openPos.entryPriceSol) * 100;
              if (pnlPct <= -this.params.stopLossPct) {
                const trade = this.closePosition(
                  openPos,
                  mint,
                  currentPriceSol,
                  timestamp,
                  event.slot ?? 0,
                  'STOP_LOSS',
                  solPriceUsd,
                );
                trades.push(trade);
                openPositions.delete(mint);
                continue;
              }
              // Check take profit
              if (pnlPct >= this.params.takeProfitPct) {
                const trade = this.closePosition(
                  openPos,
                  mint,
                  currentPriceSol,
                  timestamp,
                  event.slot ?? 0,
                  'TAKE_PROFIT',
                  solPriceUsd,
                );
                trades.push(trade);
                openPositions.delete(mint);
                continue;
              }
            }
          }
          continue;
        }

        // Buy event — add to history
        const solAmountRaw = event.data['solAmount'];
        const solAmount =
          typeof solAmountRaw === 'bigint'
            ? Number(solAmountRaw) / 1e9 // lamports → SOL
            : typeof solAmountRaw === 'number'
              ? solAmountRaw
              : parseFloat((solAmountRaw as string) ?? '0');

        let history = buyHistory.get(mint);
        if (history === undefined) {
          history = [];
          buyHistory.set(mint, history);
        }

        history.push({ timestamp, solAmount, slot: event.slot ?? 0 });

        // Trim expired buys outside the window
        const cutoff = timestamp - windowMs;
        while (history.length > 0 && history[0]!.timestamp < cutoff) {
          history.shift();
        }

        // Check momentum threshold
        if (history.length >= this.params.minBuyCount) {
          momentumSignals++;

          // Only enter if we don't already have an open position for this mint
          // (and respect max concurrent positions = 1)
          if (openPositions.size === 0 && !openPositions.has(mint)) {
            // Calculate entry price as average of the triggering buys
            let totalSol = 0;
            for (const buy of history) {
              totalSol += buy.solAmount;
            }
            const avgPriceSol = totalSol / history.length;

            const openPos: OpenPosition = {
              mint,
              entryTimestamp: timestamp,
              entrySlot: event.slot ?? 0,
              entryPriceSol: avgPriceSol,
              positionSizeUsd: this.params.positionSizeUsd,
              highestPriceSol: avgPriceSol,
            };
            openPositions.set(mint, openPos);
          }
        }
      }
    }

    // Close any remaining open positions at their entry price (data ended)
    const lastEvent = events[events.length - 1];
    const endTimestamp = lastEvent?.timestamp ?? 0;
    const endSlot = lastEvent?.slot ?? 0;

    for (const [mint, pos] of openPositions) {
      const trade = this.closePosition(
        pos,
        mint,
        pos.entryPriceSol, // No exit data, assume no change
        endTimestamp,
        endSlot,
        'TIMEOUT',
        solPriceUsd,
      );
      trades.push(trade);
    }

    logger.info('Replay complete', {
      eventsProcessed: events.length,
      momentumSignals,
      trades: trades.length,
      windowSeconds: this.params.windowSeconds,
      minBuyCount: this.params.minBuyCount,
    });

    return {
      trades,
      eventsProcessed: events.length,
      momentumSignals,
      parameters: this.params,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private closePosition(
    pos: OpenPosition,
    mint: string,
    exitPriceSol: number,
    exitTimestamp: number,
    exitSlot: number,
    reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIMEOUT',
    solPriceUsd: number,
  ): SimulatedTrade {
    const pnlPercent =
      pos.entryPriceSol > 0
        ? ((exitPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100
        : 0;

    // PnL in SOL based on position size
    const entrySol = pos.positionSizeUsd / solPriceUsd;
    const pnlSol = entrySol * (pnlPercent / 100);
    const pnlUsd = pnlSol * solPriceUsd;

    return {
      mint,
      entryTimestamp: pos.entryTimestamp,
      exitTimestamp,
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol,
      entrySlot: pos.entrySlot,
      exitSlot,
      exitReason: reason,
      pnlSol,
      pnlUsd,
      pnlPercent,
      positionSizeUsd: pos.positionSizeUsd,
      durationMs: exitTimestamp - pos.entryTimestamp,
    };
  }
}
