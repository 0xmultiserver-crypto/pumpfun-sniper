/**
 * Risk State Repository
 *
 * Persists risk-control state (JSON blobs) to the `risk_state` table.
 * Used by DailyLossGuard, CreatorBlacklist, CooldownManager to survive
 * process restarts.
 *
 * Design:
 *   - Simple key/value store (key = VARCHAR, value = JSONB)
 *   - Upsert semantics (INSERT … ON CONFLICT DO UPDATE)
 *   - Resilient: all public methods catch DB errors and log warnings
 *     rather than crashing the bot
 */

import { query } from '../postgres/postgresClient.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('storage:riskState');

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface RiskStateRow {
  readonly key: string;
  readonly value: unknown;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// RiskStateRepository
// ---------------------------------------------------------------------------

export class RiskStateRepository {
  /**
   * Persist a key/value pair. Overwrites on conflict.
   */
  async saveState(key: string, value: unknown): Promise<void> {
    try {
      await query({
        text: `INSERT INTO risk_state (key, value, updated_at)
               VALUES ($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET
                 value      = EXCLUDED.value,
                 updated_at = EXCLUDED.updated_at`,
        values: [key, JSON.stringify(value), nowMs()],
      });
    } catch (err: unknown) {
      logger.warn('Failed to save risk state', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load a value by key. Returns null if not found or on error.
   */
  async loadState<T>(key: string): Promise<T | null> {
    try {
      const result = await query<RiskStateRow>({
        text: 'SELECT key, value, updated_at FROM risk_state WHERE key = $1',
        values: [key],
      });

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      if (row === undefined) return null;

      // pg driver may return JSONB as parsed object or string
      const val = row.value;
      if (typeof val === 'string') {
        return JSON.parse(val) as T;
      }
      return val as T;
    } catch (err: unknown) {
      logger.warn('Failed to load risk state', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Delete a key from the risk state table.
   */
  async deleteState(key: string): Promise<void> {
    try {
      await query({
        text: 'DELETE FROM risk_state WHERE key = $1',
        values: [key],
      });
    } catch (err: unknown) {
      logger.warn('Failed to delete risk state', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
