/**
 * RPC Failover — priority-based failover across an RpcPool.
 *
 * ALWAYS tries the highest-priority healthy endpoint first.
 * On failure, falls back to next priority endpoint.
 * Reports success/failure to pool for health tracking.
 *
 * Flow:
 *   1. Helius (primary) → success? done.
 *   2. Helius fails → try PublicNode (fallback #1)
 *   3. PublicNode fails → try Alchemy (fallback #2)
 *   4. All fail → throw aggregate error
 *
 * After 3 consecutive failures on an endpoint, it's marked unhealthy
 * and skipped for 30s before re-check.
 *
 * Ingestion layer only: no strategy / business logic.
 */

import { RpcError } from '../../core/errors/rpc.error.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import type { RpcClient } from './rpcClient.js';
import type { RpcPool } from './rpcPool.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('rpc.failover');

// ---------------------------------------------------------------------------
// RpcFailover
// ---------------------------------------------------------------------------

export class RpcFailover {
  private readonly pool: RpcPool;

  constructor(pool: RpcPool) {
    this.pool = pool;
  }

  /**
   * Execute `fn` with automatic priority-based failover.
   *
   * Tries endpoints in priority order (healthy first).
   * On success, reports to pool. On failure, reports and tries next.
   * If all fail, throws aggregate RpcError.
   */
  async execute<T>(fn: (client: RpcClient) => Promise<T>): Promise<T> {
    const clients = this.pool.getOrderedClients();
    const errors: Array<{ endpoint: string; error: Error }> = [];

    for (const client of clients) {
      try {
        const result = await fn(client);
        this.pool.reportSuccess(client);
        return result;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ endpoint: client.endpoint, error });
        this.pool.reportFailure(client);

        logger.warn('RPC call failed, trying next endpoint', {
          attempt: errors.length,
          totalEndpoints: clients.length,
          failedEndpoint: client.endpoint.replace(/api-key=[^&]+/, 'api-key=***'),
          error: error.message,
        });
      }
    }

    // All endpoints exhausted
    const summary = errors
      .map((e, i) => `  [${i + 1}] ${e.endpoint.replace(/api-key=[^&]+/, 'api-key=***')}: ${e.error.message}`)
      .join('\n');

    logger.error('All RPC endpoints failed', {
      attempts: errors.length,
      health: this.pool.getHealthStatus(),
    });

    throw new RpcError(
      `All ${errors.length} RPC endpoints failed:\n${summary}`,
      'RPC_FAILOVER_EXHAUSTED',
      { attempts: errors.length },
    );
  }

  /**
   * Get the best (highest-priority healthy) client directly.
   * Use this when you need a Connection for subscriptions etc.
   * Falls back to primary if all unhealthy.
   */
  getBestClient(): RpcClient {
    const client = this.pool.getBest();
    if (client === null) {
      throw new RpcError('No RPC clients available', 'RPC_NO_CLIENTS', {});
    }
    return client;
  }

  /**
   * Get current health status (for telemetry/debugging).
   */
  getHealthStatus(): readonly { name: string; priority: number; healthy: boolean; failures: number }[] {
    return this.pool.getHealthStatus();
  }
}
