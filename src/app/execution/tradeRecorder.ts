import type { ServiceContainer } from '../container.js';
import type { TradeRecord } from '../../core/types/trade.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('app:execution:tradeRecorder');

/**
 * Save a trade record to the database (best-effort).
 *
 * Wraps the repository call in a try/catch so callers never need to
 * worry about DB failures aborting the trade flow.
 */
export async function saveTrade(
  container: ServiceContainer,
  record: TradeRecord,
): Promise<void> {
  try {
    await container.tradeRepository.save(record);
  } catch (err: unknown) {
    logger.error('Failed to save trade to DB — trade executed on-chain but NOT persisted', {
      tradeId: record.id,
      mint: record.mint.slice(0, 12),
      side: record.side,
      amountSol: record.amountSol.toString(),
      signature: record.signature,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
