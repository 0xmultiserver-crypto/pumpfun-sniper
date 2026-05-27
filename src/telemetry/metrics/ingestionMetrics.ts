/**
 * Ingestion metrics — stub (no-op).
 *
 * The full metrics subsystem was removed as dead code.
 * These stubs keep call sites compiling without side effects.
 * Replace with real metrics (Prometheus, etc.) when needed.
 */

/** Record a successful RPC call. */
export function recordRpcCall(_method: string, _latencyMs: number): void {
  // no-op
}

/** Record a failed RPC call. */
export function recordRpcError(_method: string, _error: string): void {
  // no-op
}

/** Record an event processed by the normalizer. */
export function recordEventProcessed(_eventType: string): void {
  // no-op
}
