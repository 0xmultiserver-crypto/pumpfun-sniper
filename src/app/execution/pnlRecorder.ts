import type { ServiceContainer } from '../container.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('app:execution:pnlRecorder');

/**
 * Record a trade's P&L with the daily loss guard and activate cooldown
 * when the exit was triggered by a stop-loss or timeout.
 *
 * This is the shared post-sell risk-recording logic used by both the
 * Jupiter and Pumpfun bonding-curve sell paths.
 *
 * @param container  Service container (dailyLossGuard + cooldownManager)
 * @param pnlUsd     Realised P&L in USD for this trade
 * @param reason     Exit reason string (e.g. 'STOP_LOSS', 'TIMEOUT', 'TAKE_PROFIT')
 * @param tradeId    Optional trade id for logging
 */
export function recordPnlAndRisk(
  container: ServiceContainer,
  pnlUsd: number,
  reason: string,
  tradeId?: string,
  mint?: string,
): void {
  const wasStopLoss = reason === 'STOP_LOSS' || reason === 'TIMEOUT' || reason === 'TRAILING_STOP';

  container.dailyLossGuard.recordTrade(pnlUsd, wasStopLoss);

  // Blacklist token on stop-loss exits to prevent re-entry
  if (wasStopLoss && mint) {
    container.tokenBlacklist.handleStopLoss(mint);
    logger.info('Token blacklisted after stop-loss exit', { tradeId, mint: mint.slice(0, 12) });
  }

  // Cooldown triggers on ALL exits except SCALE_OUT (partial sell — position
  // still active, next tier should be reachable). Previously only triggered
  // for SL/TIMEOUT/TRAILING which meant GRADUATED, KILL_SWITCH, ANTI_RUG
  // exits had zero cooldown → bot immediately FOMO-bought the next token.
  if (reason !== 'SCALE_OUT') {
    container.cooldownManager.activateCooldown();
    logger.info('Cooldown activated after exit', { tradeId, reason, pnlUsd: pnlUsd.toFixed(4) });
  }
}
