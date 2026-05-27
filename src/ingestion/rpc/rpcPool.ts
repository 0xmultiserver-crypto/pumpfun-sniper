/**
 * RPC Pool — priority-ordered pool with health tracking.
 *
 * NOT round-robin. Primary is ALWAYS tried first.
 * Fallback endpoints used only when higher-priority ones are unhealthy.
 *
 * Priority order:
 *   1. Helius (primary — paid, fastest, priority fee API)
 *   2. PublicNode (free fallback — no rate limit auth)
 *   3. Alchemy (secondary paid fallback)
 *
 * Ingestion layer only: no strategy / business logic.
 */

import { RpcClient } from './rpcClient.js';
import { createLogger } from '../../telemetry/logging/logger.js';
import { nowMs } from '../../core/utils/time.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('rpc.pool');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcEndpointConfig {
  /** Human-readable name (e.g. 'helius', 'publicnode', 'alchemy'). */
  readonly name: string;
  /** Priority (lower = higher priority). 0 = primary. */
  readonly priority: number;
  /** RPC URL. */
  readonly url: string;
  /** Timeout override (ms). Falls back to default. */
  readonly timeoutMs?: number;
  /** Commitment level override. Falls back to default. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
}

interface EndpointState {
  readonly client: RpcClient;
  readonly config: RpcEndpointConfig;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureMs: number;
  lastSuccessMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** After this many consecutive failures, mark endpoint unhealthy. */
const UNHEALTHY_THRESHOLD = 3;

/** Re-check unhealthy endpoint after this cooldown (ms). Default: 30s. */
const RECOVERY_CHECK_MS = 30_000;

// ---------------------------------------------------------------------------
// RpcPool
// ---------------------------------------------------------------------------

export class RpcPool {
  private readonly endpoints: EndpointState[];

  constructor(configs: readonly RpcEndpointConfig[], defaultTimeoutMs = 10_000) {
    if (configs.length === 0) {
      throw new Error('RpcPool requires at least one endpoint');
    }

    // Sort by priority (ascending = highest priority first)
    const sorted = [...configs].sort((a, b) => a.priority - b.priority);

    this.endpoints = sorted.map((cfg) => ({
      client: new RpcClient({
        url: cfg.url,
        timeoutMs: cfg.timeoutMs ?? defaultTimeoutMs,
        commitment: cfg.commitment ?? 'confirmed',
      }),
      config: cfg,
      healthy: true,
      consecutiveFailures: 0,
      lastFailureMs: 0,
      lastSuccessMs: 0,
    }));

    logger.info('RpcPool initialised (priority-ordered)', {
      endpoints: this.endpoints.map((e) => ({
        name: e.config.name,
        priority: e.config.priority,
      })),
    });
  }

  /** Total number of endpoints. */
  get size(): number {
    return this.endpoints.length;
  }

  /**
   * Get the highest-priority HEALTHY client.
   *
   * If all endpoints are unhealthy but some have passed the recovery
   * cooldown, those are eligible again (gives them a second chance).
   *
   * Returns null only if pool is completely empty (should never happen).
   */
  getBest(): RpcClient | null {
    // First pass: highest-priority healthy endpoint
    for (const ep of this.endpoints) {
      if (ep.healthy) {
        return ep.client;
      }
    }

    // Second pass: check if any unhealthy endpoint is past recovery cooldown
    const now = nowMs();
    for (const ep of this.endpoints) {
      if (!ep.healthy && (now - ep.lastFailureMs) >= RECOVERY_CHECK_MS) {
        logger.info('Attempting recovery for endpoint', {
          name: ep.config.name,
          downSinceMs: ep.lastFailureMs,
        });
        ep.healthy = true;
        ep.consecutiveFailures = 0;
        return ep.client;
      }
    }

    // Last resort: return primary regardless of health
    logger.warn('All endpoints unhealthy, forcing primary');
    const primary = this.endpoints[0];
    if (primary === undefined) return null;
    return primary.client;
  }

  /**
   * Get all clients in priority order for failover iteration.
   * Healthy endpoints first, then unhealthy ones past recovery cooldown.
   */
  getOrderedClients(): readonly RpcClient[] {
    const now = nowMs();
    const eligible: RpcClient[] = [];

    // Healthy first (priority order preserved from constructor sort)
    for (const ep of this.endpoints) {
      if (ep.healthy) {
        eligible.push(ep.client);
      }
    }

    // Unhealthy but past recovery cooldown
    for (const ep of this.endpoints) {
      if (!ep.healthy && (now - ep.lastFailureMs) >= RECOVERY_CHECK_MS) {
        eligible.push(ep.client);
      }
    }

    // If nothing eligible, return all (force attempt)
    if (eligible.length === 0) {
      return this.endpoints.map((e) => e.client);
    }

    return eligible;
  }

  /**
   * Report a successful call for the given client's endpoint.
   */
  reportSuccess(client: RpcClient): void {
    const ep = this.findByUrl(client.endpoint);
    if (ep === undefined) return;

    ep.consecutiveFailures = 0;
    ep.healthy = true;
    ep.lastSuccessMs = nowMs();
  }

  /**
   * Report a failed call for the given client's endpoint.
   * After UNHEALTHY_THRESHOLD consecutive failures, marks it unhealthy.
   */
  reportFailure(client: RpcClient): void {
    const ep = this.findByUrl(client.endpoint);
    if (ep === undefined) return;

    ep.consecutiveFailures++;
    ep.lastFailureMs = nowMs();

    if (ep.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
      if (ep.healthy) {
        logger.warn('Endpoint marked UNHEALTHY', {
          name: ep.config.name,
          consecutiveFailures: ep.consecutiveFailures,
        });
      }
      ep.healthy = false;
    }
  }

  /**
   * Get health status for all endpoints (for telemetry/debugging).
   */
  getHealthStatus(): readonly { name: string; priority: number; healthy: boolean; failures: number }[] {
    return this.endpoints.map((ep) => ({
      name: ep.config.name,
      priority: ep.config.priority,
      healthy: ep.healthy,
      failures: ep.consecutiveFailures,
    }));
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private findByUrl(url: string): EndpointState | undefined {
    return this.endpoints.find((e) => e.client.endpoint === url);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an RPC pool from endpoint configs.
 * Endpoints are sorted by priority automatically.
 */
export function createRpcPool(
  configs: readonly RpcEndpointConfig[],
  defaultTimeoutMs?: number,
): RpcPool {
  return new RpcPool(configs, defaultTimeoutMs);
}
