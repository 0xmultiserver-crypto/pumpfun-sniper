/**
 * Event Recorder — persists all WebSocket events to PostgreSQL for backtest replay.
 *
 * Table: backtest_events (id SERIAL, event_type TEXT, mint TEXT, slot BIGINT, timestamp BIGINT, data JSONB)
 *
 * Features:
 *   - Auto-creates table on first use (CREATE TABLE IF NOT EXISTS)
 *   - Batch inserts for performance (buffer 100 events, flush every 5s)
 *   - Query events by time range for replay
 */

import { Pool } from 'pg';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('backtest:eventRecorder');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BacktestEvent {
  readonly eventType: string;
  readonly mint: string | null;
  readonly slot: number | null;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export interface StoredBacktestEvent extends BacktestEvent {
  readonly id: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5_000;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS backtest_events (
    id         SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    mint       TEXT,
    slot       BIGINT,
    timestamp  BIGINT NOT NULL,
    data       JSONB NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_backtest_events_timestamp
    ON backtest_events (timestamp);

  CREATE INDEX IF NOT EXISTS idx_backtest_events_event_type
    ON backtest_events (event_type);

  CREATE INDEX IF NOT EXISTS idx_backtest_events_mint
    ON backtest_events (mint);
`;

// ---------------------------------------------------------------------------
// EventRecorder
// ---------------------------------------------------------------------------

export class EventRecorder {
  private readonly pool: Pool;
  private readonly buffer: BacktestEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Initialize the table and start the flush timer. */
  async start(): Promise<void> {
    if (this.initialized) return;

    await this.pool.query(CREATE_TABLE_SQL);
    this.initialized = true;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    // Ensure flush on timer unref so it doesn't keep the process alive
    if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }

    logger.info('Event recorder started', {
      batchSize: BATCH_SIZE,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    });
  }

  /** Stop the flush timer and flush remaining events. */
  async stop(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    logger.info('Event recorder stopped');
  }

  /** Buffer an event for batch insert. */
  record(event: BacktestEvent): void {
    this.buffer.push(event);

    if (this.buffer.length >= BATCH_SIZE) {
      void this.flush();
    }
  }

  /** Flush buffered events to the database. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, BATCH_SIZE);

    try {
      // Build multi-row INSERT
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const event = batch[i]!;
        const offset = i * 5;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
        );
        values.push(
          event.eventType,
          event.mint,
          event.slot,
          event.timestamp,
          JSON.stringify(event.data, (_key, val) => typeof val === 'bigint' ? val.toString() : val),
        );
      }

      const sql = `
        INSERT INTO backtest_events (event_type, mint, slot, timestamp, data)
        VALUES ${placeholders.join(', ')}
      `;

      await this.pool.query(sql, values);

      logger.debug('Flushed events to DB', { count: batch.length });
    } catch (err: unknown) {
      logger.error('Failed to flush events to DB', {
        count: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-buffer failed events at the front for retry
      this.buffer.unshift(...batch);
    }
  }

  /** Get events within a timestamp range (milliseconds). */
  async getEvents(fromMs: number, toMs: number): Promise<StoredBacktestEvent[]> {
    const result = await this.pool.query<{
      id: number;
      event_type: string;
      mint: string | null;
      slot: string | null;
      timestamp: string;
      data: Record<string, unknown>;
    }>({
      text: `SELECT id, event_type, mint, slot, timestamp, data
             FROM backtest_events
             WHERE timestamp >= $1 AND timestamp <= $2
             ORDER BY timestamp ASC, id ASC`,
      values: [fromMs, toMs],
    });

    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      mint: row.mint,
      slot: row.slot !== null ? Number(row.slot) : null,
      timestamp: Number(row.timestamp),
      data: row.data,
    }));
  }

  /** Get event count within a timestamp range. */
  async getEventCount(fromMs: number, toMs: number): Promise<number> {
    const result = await this.pool.query<{ count: string }>({
      text: `SELECT COUNT(*) as count
             FROM backtest_events
             WHERE timestamp >= $1 AND timestamp <= $2`,
      values: [fromMs, toMs],
    });

    return Number(result.rows[0]?.count ?? '0');
  }
}
