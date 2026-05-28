/**
 * Ingestion metrics — thin wrappers over Prometheus counters.
 */

import { eventsTotal } from './prometheus.js';

/** Record a successful RPC call. */
export function recordRpcCall(_method: string, _latencyMs: number): void {
  // No dedicated RPC counter yet — add when RPC latency tracking is needed.
}

/** Record a failed RPC call. */
export function recordRpcError(_method: string, _error: string): void {
  // No dedicated RPC error counter yet — add when RPC reliability tracking is needed.
}

/** Record an event processed by the normalizer. */
export function recordEventProcessed(eventType: string): void {
  eventsTotal.inc({ type: eventType });
}
