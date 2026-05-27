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

/**
 * Update an existing trade record's status and related fields.
 *
 * Semantically identical to saveTrade (the repository uses an upsert),
 * but exists as a named intent for callers that are updating a
 * previously-saved record (e.g. changing status from PENDING to CONFIRMED).
 */
export async function updateTradeStatus(
  container: ServiceContainer,
  record: TradeRecord,
): Promise<void> {
  try {
    await container.tradeRepository.save(record);
  } catch (_) {
    /* best effort */
  }
}
