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
): void {
  const wasStopLoss = reason === 'STOP_LOSS' || reason === 'TIMEOUT' || reason === 'TRAILING_STOP';

  container.dailyLossGuard.recordTrade(pnlUsd, wasStopLoss);

  if (wasStopLoss) {
    container.cooldownManager.activateCooldown();
    logger.info('Cooldown activated after stop loss', { tradeId, reason });
  }
}
