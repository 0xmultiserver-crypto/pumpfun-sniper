/**
 * Postgres client wrapper — persistence layer only, zero business logic.
 *
 * Exports:
 *   createPool      – build a pg Pool from a connection string
 *   query           – run a parameterised query
 *   transaction     – execute a callback inside BEGIN / COMMIT / ROLLBACK
 *   healthCheck     – lightweight SELECT 1 ping
 *   disconnect      – graceful pool shutdown
 */

import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/* ------------------------------------------------------------------ */
/*  Pool factory                                                      */
/* ------------------------------------------------------------------ */

export interface PostgresPoolOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

let pool: Pool | undefined;

/**
 * Create (or return existing) connection pool.
 * Call once at startup; subsequent calls with the same string are idempotent.
 */
export function createPool(opts: PostgresPoolOptions): Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.maxConnections ?? 20,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
  });

  /* Surface unexpected background errors so the process can react. */
  pool.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('[postgres] unexpected pool error', err.message);
  });

  return pool;
}

/**
 * Return the live pool (throws if createPool was never called).
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('[postgres] Pool not initialised — call createPool() first');
  }
  return pool;
}

/* ------------------------------------------------------------------ */
/*  Query helper                                                      */
/* ------------------------------------------------------------------ */

export interface QueryOptions {
  readonly text: string;
  readonly values?: readonly unknown[];
}

/**
 * Execute a parameterised SQL statement against the pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  opts: QueryOptions,
): Promise<QueryResult<T>> {
  const p = getPool();
  return p.query<T>(opts.text, opts.values as unknown[]);
}

/* ------------------------------------------------------------------ */
/*  Transaction helper                                                */
/* ------------------------------------------------------------------ */

/**
 * Run `fn` inside a database transaction.
 * Automatically issues BEGIN before and COMMIT after.
 * On error, issues ROLLBACK then re-throws.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/*  Health check                                                      */
/* ------------------------------------------------------------------ */

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

/**
 * Lightweight ping — runs `SELECT 1` and reports latency.
 */
export async function healthCheck(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    await query({ text: 'SELECT 1' });
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: message,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Graceful disconnect                                               */
/* ------------------------------------------------------------------ */

/**
 * Drain the pool and release all connections.
 * Safe to call multiple times.
 */
export async function disconnect(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
