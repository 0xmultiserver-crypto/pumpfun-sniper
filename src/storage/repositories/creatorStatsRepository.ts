/**
 * Creator Stats Repository
 *
 * Tracks creator wallet performance scores based on trade outcomes.
 * Creators with low scores are auto-blacklisted by the entry check evaluator.
 *
 * Design:
 *   - Upsert semantics (INSERT … ON CONFLICT DO UPDATE)
 *   - Running average for survival time
 *   - Score: starts at 50. TP +5, SL -10, TIMEOUT -3, TRAILING +2. Clamped 0-100.
 *   - Resilient: all public methods catch DB errors and log warnings
 */

import { query } from '../postgres/postgresClient.js';
import { nowMs } from '../../core/utils/time.js';
import { createLogger } from '../../telemetry/logging/logger.js';

const logger = createLogger('storage:creatorStats');

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface CreatorStatsRow {
  readonly wallet: string;
  readonly total_launches: string;
  readonly total_sl_hits: string;
  readonly total_tp_hits: string;
  readonly avg_survival_seconds: string;
  readonly score: string;
  readonly last_updated: string;
}

// ---------------------------------------------------------------------------
// Score delta map
// ---------------------------------------------------------------------------

const SCORE_DELTAS: Record<string, number> = {
  SL: -10,
  TP: +5,
  TIMEOUT: -3,
  TRAILING: +2,
};

// ---------------------------------------------------------------------------
// CreatorStatsRepository
// ---------------------------------------------------------------------------

export class CreatorStatsRepository {
  /**
   * Get the creator score for a wallet. Returns 0-100, default 50.
   */
  async getScore(wallet: string): Promise<number> {
    try {
      const result = await query<CreatorStatsRow>({
        text: 'SELECT wallet, total_launches, total_sl_hits, total_tp_hits, avg_survival_seconds, score, last_updated FROM creator_stats WHERE wallet = $1',
        values: [wallet],
      });

      if (result.rows.length === 0) return 50;

      const row = result.rows[0];
      if (row === undefined) return 50;

      return Number(row.score);
    } catch (err: unknown) {
      logger.warn('Failed to get creator score', {
        wallet,
        error: err instanceof Error ? err.message : String(err),
      });
      return 50;
    }
  }

  /**
   * Record a trade outcome for a creator wallet.
   * Uses upsert to update running stats.
   *
   * @param wallet           Creator wallet address
   * @param outcome          Trade outcome: 'SL' | 'TP' | 'TIMEOUT' | 'TRAILING'
   * @param survivalSeconds  How long the position survived
   */
  async recordTrade(
    wallet: string,
    outcome: 'SL' | 'TP' | 'TIMEOUT' | 'TRAILING',
    survivalSeconds: number,
  ): Promise<void> {
    const delta = SCORE_DELTAS[outcome] ?? 0;
    const isSL = outcome === 'SL' ? 1 : 0;
    const isTP = outcome === 'TP' ? 1 : 0;

    try {
      // Upsert: insert new row or update existing stats
      await query({
        text: `INSERT INTO creator_stats (
          wallet, total_launches, total_sl_hits, total_tp_hits,
          avg_survival_seconds, score, last_updated
        ) VALUES ($1, 1, $2, $3, $4, GREATEST(0, LEAST(100, 50 + $5)), $6)
        ON CONFLICT (wallet) DO UPDATE SET
          total_launches = creator_stats.total_launches + 1,
          total_sl_hits = creator_stats.total_sl_hits + $2,
          total_tp_hits = creator_stats.total_tp_hits + $3,
          avg_survival_seconds = (
            (creator_stats.avg_survival_seconds * creator_stats.total_launches + $4)
            / (creator_stats.total_launches + 1)
          ),
          score = GREATEST(0, LEAST(100, creator_stats.score + $5)),
          last_updated = $6`,
        values: [wallet, isSL, isTP, survivalSeconds, delta, nowMs()],
      });
    } catch (err: unknown) {
      logger.warn('Failed to record creator trade', {
        wallet,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
