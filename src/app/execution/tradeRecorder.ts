import type { ServiceContainer } from '../container.js';
import type { TradeRecord } from '../../core/types/trade.js';

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
  } catch (_) {
    /* best effort */
  }
}


