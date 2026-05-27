/**
 * Exit Decision
 *
 * Evaluates whether a position should be exited based on:
 *   - Take profit (+500%)
 *   - Stop loss (-50%)
 *   - Timeout (60 minutes)
 *
 * All values are LOCKED in filteredSniperRules.ts.
 *
 * Strategy = business logic ONLY. No RPC, no DB, no protocol decoding.
 */

import {
  TAKE_PROFIT_PERCENT,
  STOP_LOSS_PERCENT,
  TRAILING_STOP_PCT,
  TRAILING_ACTIVATION_PCT,
  TIMEOUT_MS,
  SCALE_OUT_ENABLED,
  SCALE_OUT_TIERS,
} from './filteredSniperRules.js';
import type { MintAddress } from '../../core/types/token.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('strategy:exitDecision');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Exit reason. */
// ExitReason: import for local use + re-export for downstream consumers
import type { ExitReason } from '../../core/types/strategy.js';
export type { ExitReason } from '../../core/types/strategy.js';

/** Position data for exit evaluation. */
export interface PositionData {
  readonly mint: MintAddress;
  readonly tradeId: string;
  /** Entry price in lamports per token (BigInt). */
  readonly entryPriceLamports: bigint;
  /** Current price in lamports per token (BigInt). */
  readonly currentPriceLamports: bigint;
  /** When the position was opened (ms epoch). */
  readonly openedAt: number;
  /** Whether the global kill switch is active. */
  readonly killSwitchActive: boolean;
  /** Whether the token has graduated from bonding curve (migrated to Raydium/Orca). */
  readonly graduated?: boolean;
  /** Highest price seen since entry (for trailing stop). Updated each poll. */
  readonly highestPriceLamports?: bigint;
  /** Anti-rug monitor detected a suspicious dump by a top holder. */
  readonly antiRugTriggered?: boolean;
  /** Which scale-out tiers have already been sold (by index). */
  readonly scaleOutTiersCompleted?: readonly number[];
}

/** Exit decision result. */
export interface ExitDecisionResult {
  /** Whether the position should be exited. */
  readonly shouldExit: boolean;
  /** Exit reason (if shouldExit is true). */
  readonly reason: ExitReason | null;
  /** Current P&L in percent (can be negative). */
  readonly pnlPercent: number;
  /** Time elapsed since position opened, in ms. */
  readonly elapsedMs: number;
  /** Human-readable explanation. */
  readonly explanation: string;
  /** Percentage of current balance to sell (default 100). Used by SCALE_OUT. */
  readonly sellPct?: number;
}

// ---------------------------------------------------------------------------
// Exit Decision
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a position should be exited.
 *
 * Priority order:
 *   1. Kill switch (highest priority — immediate exit)
 *   2. Stop loss (protect capital)
 *   3. Take profit (lock gains)
 *   4. Timeout (prevent stale positions)
 *
 * P&L calculation uses BigInt to avoid floating point errors.
 * pnlPercent = ((current - entry) * 10000 / entry) / 100
 *            = basis points / 100 → percentage
 */
export function evaluateExit(data: PositionData): ExitDecisionResult {
  const now = nowMs();
  const elapsedMs = now - data.openedAt;

  // --- Check 0: Graduated token (bonding curve complete) ---
  // When a token graduates, bonding curve reserves are drained so PnL
  // from bonding curve price is meaningless (shows -100%). Route to
  // Jupiter sell immediately instead of triggering false STOP_LOSS.
  if (data.graduated) {
    logger.info('Exit decision: TOKEN GRADUATED — routing to Jupiter', {
      tradeId: data.tradeId,
      mint: data.mint,
      elapsedMs,
    });
    return {
      shouldExit: true,
      reason: 'GRADUATED',
      pnlPercent: 0, // PnL unknown until Jupiter quote
      elapsedMs,
      explanation: 'Token graduated from bonding curve — sell via Jupiter',
    };
  }

  // Calculate P&L in basis points using BigInt
  // pnlBps = (current - entry) * 10000n / entry
  let pnlBps: bigint;
  if (data.entryPriceLamports === 0n) {
    pnlBps = 0n;
  } else {
    pnlBps =
      ((data.currentPriceLamports - data.entryPriceLamports) * 10000n) /
      data.entryPriceLamports;
  }

  // Convert to percentage (float, for display/comparison only)
  const pnlPercent = Number(pnlBps) / 100;

  // --- Check 1: Kill switch ---
  if (data.killSwitchActive) {
    logger.warn('Exit decision: KILL SWITCH active', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'KILL_SWITCH',
      pnlPercent,
      elapsedMs,
      explanation: 'Emergency kill switch is active — exiting immediately',
    };
  }

  // --- Check 1.5: Scale-out (partial profit taking) ---
  // Highest priority after kill switch. Checks if any tier trigger has been
  // reached and not yet completed. Returns partial sell percentage.
  if (SCALE_OUT_ENABLED && SCALE_OUT_TIERS.length > 0 && data.entryPriceLamports > 0n) {
    const completedTiers = new Set(data.scaleOutTiersCompleted ?? []);
    for (let i = 0; i < SCALE_OUT_TIERS.length; i++) {
      const tier = SCALE_OUT_TIERS[i]!;
      if (completedTiers.has(i)) continue;
      const triggerBps = BigInt(tier.triggerPct * 100);
      if (pnlBps >= triggerBps) {
        logger.info('Exit decision: SCALE_OUT triggered', {
          tradeId: data.tradeId,
          mint: data.mint,
          tierIndex: i,
          triggerPct: tier.triggerPct,
          sellPct: tier.sellPct,
          pnlPercent: pnlPercent.toFixed(2),
        });
        return {
          shouldExit: true,
          reason: 'SCALE_OUT',
          pnlPercent,
          elapsedMs,
          sellPct: tier.sellPct,
          explanation: `Scale-out tier ${i + 1}: P&L ${pnlPercent.toFixed(2)}% >= +${tier.triggerPct}% — sell ${tier.sellPct}% of position`,
        };
      }
    }
  }

  // --- Check 2: Trailing stop (activates after TRAILING_ACTIVATION_PCT profit) ---
  // Trails from highest price seen. Only active when position has reached activation threshold.
  if (TRAILING_STOP_PCT > 0 && data.highestPriceLamports && data.entryPriceLamports > 0n) {
    const highestPnlBps = ((data.highestPriceLamports - data.entryPriceLamports) * 10000n) / data.entryPriceLamports;
    const activationBps = BigInt(TRAILING_ACTIVATION_PCT * 100);
    // Only trail if highest exceeded activation threshold
    if (highestPnlBps >= activationBps) {
      // Trailing stop price = highest * (100 - trailingPct) / 100
      const trailingStopPrice = (data.highestPriceLamports * BigInt(100 - TRAILING_STOP_PCT)) / 100n;
      if (data.currentPriceLamports <= trailingStopPrice) {
        const trailingPnlBps = ((data.currentPriceLamports - data.entryPriceLamports) * 10000n) / data.entryPriceLamports;
        const trailingPnlPercent = Number(trailingPnlBps) / 100;
        logger.warn('Exit decision: TRAILING STOP triggered', {
          tradeId: data.tradeId,
          mint: data.mint,
          highestPrice: data.highestPriceLamports.toString(),
          currentPrice: data.currentPriceLamports.toString(),
          trailingStopPrice: trailingStopPrice.toString(),
          pnlPercent: trailingPnlPercent.toFixed(2),
          trailingStopPct: TRAILING_STOP_PCT,
        });
        return {
          shouldExit: true,
          reason: 'TRAILING_STOP',
          pnlPercent: trailingPnlPercent,
          elapsedMs,
          explanation: `Trailing stop triggered: price dropped ${TRAILING_STOP_PCT}% from high (PNL ${trailingPnlPercent.toFixed(2)}%)`,
        };
      }
    }
  }

  // --- Check 2.5: Anti-rug (detected by AntiRugMonitor) ---
  if (data.antiRugTriggered) {
    logger.warn('Exit decision: ANTI_RUG triggered — top holder dump detected', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
    });
    return {
      shouldExit: true,
      reason: 'ANTI_RUG',
      pnlPercent,
      elapsedMs,
      explanation: 'Anti-rug triggered: suspicious large dump detected by top holder',
    };
  }

  // --- Check 3: Stop loss ---
  if (pnlPercent <= STOP_LOSS_PERCENT) {
    logger.warn('Exit decision: STOP LOSS triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      threshold: STOP_LOSS_PERCENT,
    });
    return {
      shouldExit: true,
      reason: 'STOP_LOSS',
      pnlPercent,
      elapsedMs,
      explanation: `Stop loss triggered: P&L ${pnlPercent.toFixed(2)}% <= ${STOP_LOSS_PERCENT}%`,
    };
  }

  // --- Check 4: Take profit ---
  if (pnlPercent >= TAKE_PROFIT_PERCENT) {
    logger.info('Exit decision: TAKE PROFIT triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      threshold: TAKE_PROFIT_PERCENT,
    });
    return {
      shouldExit: true,
      reason: 'TAKE_PROFIT',
      pnlPercent,
      elapsedMs,
      explanation: `Take profit triggered: P&L ${pnlPercent.toFixed(2)}% >= +${TAKE_PROFIT_PERCENT}%`,
    };
  }

  // --- Check 4: Timeout ---
  if (elapsedMs >= TIMEOUT_MS) {
    logger.info('Exit decision: TIMEOUT triggered', {
      tradeId: data.tradeId,
      mint: data.mint,
      pnlPercent: pnlPercent.toFixed(2),
      elapsedMs,
      timeoutMs: TIMEOUT_MS,
    });
    return {
      shouldExit: true,
      reason: 'TIMEOUT',
      pnlPercent,
      elapsedMs,
      explanation: `Timeout triggered: ${Math.round(elapsedMs / 1000)}s >= ${TIMEOUT_MS / 1000}s`,
    };
  }

  // --- No exit condition met ---
  return {
    shouldExit: false,
    reason: null,
    pnlPercent,
    elapsedMs,
    explanation: `Holding: P&L ${pnlPercent.toFixed(2)}%, elapsed ${Math.round(elapsedMs / 1000)}s`,
  };
}
