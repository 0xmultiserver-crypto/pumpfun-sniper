/**
 * Timeout constants.
 *
 * All timeouts explicit — no hidden defaults.
 * Sourced from protocol requirements and rule.md.
 */

/** RPC request timeout in ms */
export const RPC_TIMEOUT_MS = 10_000 as const;

/** Graceful shutdown timeout in ms */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000 as const;
