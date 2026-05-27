/**
 * Trade Lifecycle Manager
 *
 * Manages the full lifecycle of a single trade:
 *   PENDING → SENT → CONFIRMED → MONITORING → EXITED
 *
 * Tracks state transitions and emits lifecycle events.
 *
 * Execution = tx building + sending ONLY. No strategy logic.
 */

import type { MintAddress } from '../../core/types/token.js';
import type { SwapDirection } from '../../core/types/execution.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('execution:tradeLifecycle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Trade lifecycle states. */
export type TradeState =
  | 'PENDING'       // Trade created, not yet sent
  | 'SENT'          // Transaction sent, awaiting confirmation
  | 'CONFIRMED'     // Transaction confirmed on-chain
  | 'MONITORING'    // Position open, monitoring for exit
  | 'EXIT_SENT'     // Exit transaction sent
  | 'EXIT_CONFIRMED'// Exit transaction confirmed
  | 'COMPLETED'     // Trade fully completed
  | 'FAILED'        // Trade failed at some point
  | 'CANCELLED';    // Trade cancelled before execution

/** Trade record. */
export interface TradeRecord {
  readonly tradeId: string;
  readonly mint: MintAddress;
  readonly direction: SwapDirection;
  state: TradeState;
  readonly entrySignature: string | null;
  readonly exitSignature: string | null;
  readonly entryAmountLamports: bigint;
  readonly exitAmountLamports: bigint | null;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly confirmedAt: number | null;
  readonly exitedAt: number | null;
  readonly failReason: string | null;
}

/** Lifecycle event handler. */
export type LifecycleHandler = (trade: TradeRecord, previousState: TradeState) => void;

// ---------------------------------------------------------------------------
// TradeLifecycleManager
// ---------------------------------------------------------------------------

export class TradeLifecycleManager {
  private readonly trades = new Map<string, TradeRecord>();
  private readonly handlers: LifecycleHandler[] = [];

  /**
   * Create a new trade in PENDING state.
   */
  createTrade(
    tradeId: string,
    mint: MintAddress,
    direction: SwapDirection,
    amountLamports: bigint,
  ): TradeRecord {
    if (this.trades.has(tradeId)) {
      throw new Error(`Trade already exists: ${tradeId}`);
    }

    const trade: TradeRecord = {
      tradeId,
      mint,
      direction,
      state: 'PENDING',
      entrySignature: null,
      exitSignature: null,
      entryAmountLamports: amountLamports,
      exitAmountLamports: null,
      createdAt: nowMs(),
      sentAt: null,
      confirmedAt: null,
      exitedAt: null,
      failReason: null,
    };

    this.trades.set(tradeId, trade);
    logger.info('Trade created', { tradeId, mint, direction });
    return trade;
  }

  /**
   * Transition a trade to a new state.
   */
  transition(
    tradeId: string,
    newState: TradeState,
    updates?: Partial<Pick<TradeRecord, 'entrySignature' | 'exitSignature' | 'exitAmountLamports' | 'failReason'>>,
  ): TradeRecord {
    const trade = this.trades.get(tradeId);
    if (trade === undefined) {
      throw new Error(`Trade not found: ${tradeId}`);
    }

    const previousState = trade.state;

    // Apply state
    (trade as { state: TradeState }).state = newState;

    // Apply timestamp updates
    if (newState === 'SENT') {
      (trade as { sentAt: number | null }).sentAt = nowMs();
    } else if (newState === 'CONFIRMED') {
      (trade as { confirmedAt: number | null }).confirmedAt = nowMs();
    } else if (newState === 'EXIT_CONFIRMED' || newState === 'COMPLETED') {
      (trade as { exitedAt: number | null }).exitedAt = nowMs();
    }

    // Apply optional updates
    if (updates?.entrySignature !== undefined) {
      (trade as { entrySignature: string | null }).entrySignature = updates.entrySignature;
    }
    if (updates?.exitSignature !== undefined) {
      (trade as { exitSignature: string | null }).exitSignature = updates.exitSignature;
    }
    if (updates?.exitAmountLamports !== undefined) {
      (trade as { exitAmountLamports: bigint | null }).exitAmountLamports = updates.exitAmountLamports;
    }
    if (updates?.failReason !== undefined) {
      (trade as { failReason: string | null }).failReason = updates.failReason;
    }

    logger.info('Trade state transition', {
      tradeId,
      from: previousState,
      to: newState,
      mint: trade.mint,
    });

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(trade, previousState);
      } catch (err: unknown) {
        logger.error('Lifecycle handler threw', {
          tradeId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return trade;
  }

  /**
   * Get a trade by ID.
   */
  getTrade(tradeId: string): TradeRecord | null {
    return this.trades.get(tradeId) ?? null;
  }

  /**
   * Get all active trades (not completed/failed/cancelled).
   */
  getActiveTrades(): readonly TradeRecord[] {
    const active: TradeRecord[] = [];
    for (const trade of this.trades.values()) {
      if (
        trade.state !== 'COMPLETED' &&
        trade.state !== 'FAILED' &&
        trade.state !== 'CANCELLED'
      ) {
        active.push(trade);
      }
    }
    return active;
  }

  /**
   * Register a lifecycle event handler.
   */
  onTransition(handler: LifecycleHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Get count of active trades.
   */
  get activeTradeCount(): number {
    let count = 0;
    for (const trade of this.trades.values()) {
      if (
        trade.state !== 'COMPLETED' &&
        trade.state !== 'FAILED' &&
        trade.state !== 'CANCELLED'
      ) {
        count += 1;
      }
    }
    return count;
  }
}
